import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DB } from "../db";
import { payoutAccounts, users } from "../db/schema";

export const payoutInput = z
  .object({
    bankCode: z.string().regex(/^\d{3,6}$/),
    accountNumber: z.string().regex(/^\d{10}$/),
  })
  .strict();

export function paystackCredentials() {
  const secret = process.env.PAYSTACK_SECRET_KEY ?? "";
  const mode = secret.startsWith("sk_test_")
    ? "test"
    : secret.startsWith("sk_live_")
      ? "live"
      : null;
  if (!mode)
    throw new HTTPException(503, {
      message: "Paystack credentials are not configured",
    });
  return {
    secret,
    mode,
    fingerprint: createHash("sha256").update(secret).digest("hex"),
  };
}

export async function paystackResponse(
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
) {
  const { secret } = paystackCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await request(`https://api.paystack.co${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    const result = z
      .object({
        status: z.literal(true),
        data: z.unknown(),
        meta: z.unknown().optional(),
      })
      .safeParse(await response.json());
    if (!response.ok || !result.success)
      throw new Error("Provider request failed");
    return result.data;
  } catch {
    // Provider responses and URLs can contain account numbers or credentials.
    throw new HTTPException(502, {
      message: "Paystack request failed. Please try again later",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function paystackRequest(
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
) {
  return (await paystackResponse(path, init, request)).data;
}

export function payoutView(account: typeof payoutAccounts.$inferSelect) {
  return {
    status: account.status,
    mode: account.mode,
    bankCode: account.bankCode,
    accountLast4: account.accountLast4,
    accountName: account.accountName,
  };
}

export async function setupPayoutAccount(
  database: DB,
  userId: string,
  input: z.infer<typeof payoutInput>,
  request: typeof fetch = fetch,
) {
  const parsed = payoutInput.parse(input);
  const { mode, secret, fingerprint } = paystackCredentials();
  const requestHash = createHmac("sha256", secret)
    .update(`${userId}:${parsed.bankCode}:${parsed.accountNumber}`)
    .digest("hex");
  const where = and(
    eq(payoutAccounts.userId, userId),
    eq(payoutAccounts.mode, mode),
  );
  const existing = await database.query.payoutAccounts.findFirst({ where });
  if (existing) {
    if (
      existing.keyFingerprint !== fingerprint ||
      existing.requestHash !== requestHash
    )
      throw new HTTPException(409, {
        message: "Payout account changes require a reviewed migration",
      });
    if (existing.status !== "ready")
      throw new HTTPException(409, {
        message:
          "Payout setup is pending provider reconciliation; do not submit it again",
      });
    return payoutView(existing);
  }
  const user = await database.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new HTTPException(404, { message: "User not found" });
  const resolved = z
    .object({
      account_number: z.literal(parsed.accountNumber),
      account_name: z.string().trim().min(1).max(200),
    })
    .safeParse(
      await paystackRequest(
        `/bank/resolve?${new URLSearchParams({ account_number: parsed.accountNumber, bank_code: parsed.bankCode })}`,
        {},
        request,
      ),
    );
  if (!resolved.success)
    throw new HTTPException(502, {
      message: "Paystack returned invalid bank account details",
    });
  // Commit the reservation before creating a remote resource. An ambiguous timeout
  // stays pending instead of creating another subaccount on an automatic retry.
  const [reserved] = await database
    .insert(payoutAccounts)
    .values({
      id: randomUUID(),
      userId,
      mode,
      bankCode: parsed.bankCode,
      accountLast4: parsed.accountNumber.slice(-4),
      accountName: resolved.data.account_name,
      requestHash,
      keyFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning();
  if (!reserved)
    throw new HTTPException(409, {
      message: "Payout setup already started; refresh its status",
    });
  const remote = z
    .object({
      subaccount_code: z.string().regex(/^ACCT_[A-Za-z0-9]+$/),
      domain: z.literal(mode),
      currency: z.literal("NGN"),
      account_number: z.literal(parsed.accountNumber),
      percentage_charge: z.literal(0),
      active: z.literal(true),
    })
    .safeParse(
      await paystackRequest(
        "/subaccount",
        {
          method: "POST",
          body: JSON.stringify({
            business_name: user.businessName ?? user.fullName,
            settlement_bank: parsed.bankCode,
            account_number: parsed.accountNumber,
            percentage_charge: 0,
            description: `Billd payout ${reserved.id}`,
          }),
        },
        request,
      ),
    );
  if (!remote.success)
    throw new HTTPException(502, {
      message: "Payout setup needs provider reconciliation",
    });
  const [ready] = await database
    .update(payoutAccounts)
    .set({ status: "ready", subaccountCode: remote.data.subaccount_code })
    .where(eq(payoutAccounts.id, reserved.id))
    .returning();
  return payoutView(ready);
}

export async function reconcilePayoutAccount(
  database: DB,
  id: string,
  code: string,
  request: typeof fetch = fetch,
) {
  if (!z.uuid().safeParse(id).success || !/^ACCT_[A-Za-z0-9]+$/.test(code))
    throw new HTTPException(400, {
      message:
        "A payout account UUID and Paystack subaccount code are required",
    });
  const { mode, secret, fingerprint } = paystackCredentials();
  const account = await database.query.payoutAccounts.findFirst({
    where: eq(payoutAccounts.id, id),
  });
  if (
    !account ||
    account.mode !== mode ||
    account.keyFingerprint !== fingerprint
  )
    throw new HTTPException(409, {
      message:
        "Payout account does not match the configured Paystack credentials",
    });
  if (account.status === "ready") {
    if (account.subaccountCode !== code)
      throw new HTTPException(409, {
        message: "Payout account is already linked to another subaccount",
      });
    return payoutView(account);
  }
  const remote = z
    .object({
      subaccount_code: z.literal(code),
      domain: z.literal(mode),
      currency: z.literal("NGN"),
      active: z.literal(true),
      percentage_charge: z.literal(0),
      description: z.literal(`Billd payout ${id}`),
      account_number: z.string().regex(/^\d{10}$/),
    })
    .safeParse(
      await paystackRequest(
        `/subaccount/${encodeURIComponent(code)}`,
        {},
        request,
      ),
    );
  if (
    !remote.success ||
    createHmac("sha256", secret)
      .update(
        `${account.userId}:${account.bankCode}:${remote.data.account_number}`,
      )
      .digest("hex") !== account.requestHash
  )
    throw new HTTPException(409, {
      message: "Provider subaccount does not match the pending payout setup",
    });
  const [ready] = await database
    .update(payoutAccounts)
    .set({ status: "ready", subaccountCode: code })
    .where(and(eq(payoutAccounts.id, id), eq(payoutAccounts.status, "pending")))
    .returning();
  if (!ready)
    throw new HTTPException(409, {
      message:
        "Payout account changed during reconciliation; refresh its status",
    });
  return payoutView(ready);
}
