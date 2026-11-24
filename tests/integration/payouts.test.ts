import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import * as schema from "../../src/db/schema";
import {
  setupPayoutAccount,
  reconcilePayoutAccount,
} from "../../src/lib/payouts";
import { initializeInvoiceCheckout } from "../../src/lib/payment-checkout";
import {
  recordPaystackPayment,
  type PaystackCharge,
} from "../../src/lib/payments";
import { createDraftInvoice } from "../../src/lib/invoices";

const context = createTestDatabase();
const { database, client } = context;
const input = { bankCode: "058", accountNumber: "0123456789" };
const previousKey = process.env.PAYSTACK_SECRET_KEY;
beforeAll(async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_billd_payout_fixture";
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET =
    "payout-tests-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "payout-tests-refresh-secret-at-least-32-bytes";
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}, 30_000);
afterAll(async () => {
  if (previousKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = previousKey;
  await context.close();
});

async function owner() {
  const id = randomUUID();
  await database.insert(schema.users).values({
    id,
    email: `${id}@example.test`,
    fullName: "Payout Owner",
    emailVerifiedAt: new Date(),
  });
  return id;
}
function provider() {
  const code = `ACCT_${randomUUID().replaceAll("-", "")}`;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const remote = {
    subaccount_code: code,
    domain: "test",
    currency: "NGN",
    active: true,
    account_number: input.accountNumber,
    percentage_charge: 0,
    description: "",
  };
  let failCreation = false;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path === "/bank/resolve")
      return Response.json({
        status: true,
        data: {
          account_number: input.accountNumber,
          account_name: "Resolved Owner",
        },
      });
    if (path === "/subaccount") {
      remote.description = body.description;
      if (failCreation) throw new Error("Ambiguous provider timeout");
      return Response.json({ status: true, data: remote });
    }
    if (path === `/subaccount/${code}`)
      return Response.json({ status: true, data: remote });
    if (path === "/transaction/initialize")
      return Response.json({
        status: true,
        data: {
          reference: body.reference,
          authorization_url: "https://checkout.paystack.com/testfixture",
        },
      });
    throw new Error("Unexpected provider endpoint");
  }) as typeof fetch;
  return {
    code,
    remote,
    calls,
    request,
    timeoutCreation: () => {
      failCreation = true;
    },
  };
}
async function draft(userId: string) {
  const clientId = randomUUID();
  await database.insert(schema.clients).values({
    id: clientId,
    userId,
    name: "Payer",
    email: "payer@example.test",
  });
  return (await createDraftInvoice(database, userId, {
    clientId,
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
    items: [{ description: "Work", quantity: 1, rate: 1250.5 }],
  }))!;
}

test("payout setup retries reuse one subaccount and expose only masked account details", async () => {
  const id = await owner(),
    api = provider();
  const first = await setupPayoutAccount(database, id, input, api.request);
  expect(await setupPayoutAccount(database, id, input, api.request)).toEqual(
    first,
  );
  expect(first).toEqual({
    status: "ready",
    mode: "test",
    bankCode: "058",
    accountLast4: "6789",
    accountName: "Resolved Owner",
  });
  expect(api.calls.filter((c) => c.path === "/subaccount")).toHaveLength(1);
  expect(
    api.calls.find((c) => c.path === "/subaccount")?.body.percentage_charge,
  ).toBe(0);
  const history = await database.query.auditEvents.findMany({
    where: eq(schema.auditEvents.ownerId, id),
  });
  expect(history.map((e) => e.action)).toEqual(
    expect.arrayContaining(["payout.setup_started", "payout.setup_completed"]),
  );
  expect(JSON.stringify(history)).not.toContain(input.accountNumber);
  await expect(
    setupPayoutAccount(
      database,
      id,
      { ...input, bankCode: "044" },
      api.request,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

test("concurrent setup creates one remote resource", async () => {
  const id = await owner(),
    api = provider();
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      setupPayoutAccount(database, id, input, api.request),
    ),
  );
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(api.calls.filter((c) => c.path === "/subaccount")).toHaveLength(1);
});

test("ambiguous creation stays pending until the matching provider record is reconciled", async () => {
  const id = await owner(),
    api = provider();
  api.timeoutCreation();
  await expect(
    setupPayoutAccount(database, id, input, api.request),
  ).rejects.toMatchObject({ status: 502 });
  await expect(
    setupPayoutAccount(database, id, input, api.request),
  ).rejects.toMatchObject({ status: 409 });
  const pending = (await database.query.payoutAccounts.findFirst({
    where: eq(schema.payoutAccounts.userId, id),
  }))!;
  expect(pending.status).toBe("pending");
  const description = api.remote.description;
  api.remote.description = "Another setup";
  await expect(
    reconcilePayoutAccount(database, pending.id, api.code, api.request),
  ).rejects.toMatchObject({ status: 409 });
  api.remote.description = description;
  api.remote.account_number = "9999999999";
  await expect(
    reconcilePayoutAccount(database, pending.id, api.code, api.request),
  ).rejects.toMatchObject({ status: 409 });
  api.remote.account_number = input.accountNumber;
  expect(
    (await reconcilePayoutAccount(database, pending.id, api.code, api.request))
      .status,
  ).toBe("ready");
  expect(api.calls.filter((c) => c.path === "/subaccount")).toHaveLength(1);
});

test("checkout requires the owner's ready subaccount and saves zero commission with freelancer fees", async () => {
  const id = await owner(),
    api = provider(),
    invoice = await draft(id);
  await expect(
    database.transaction((tx) =>
      initializeInvoiceCheckout(
        tx,
        id,
        invoice,
        "payer@example.test",
        api.request,
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await setupPayoutAccount(database, id, input, api.request);
  api.remote.active = false;
  await expect(
    database.transaction((tx) =>
      initializeInvoiceCheckout(
        tx,
        id,
        invoice,
        "payer@example.test",
        api.request,
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
  api.remote.active = true;
  await database.transaction((tx) =>
    initializeInvoiceCheckout(
      tx,
      id,
      invoice,
      "payer@example.test",
      api.request,
    ),
  );
  const sent = api.calls.find(
    (c) => c.path === "/transaction/initialize",
  )!.body;
  expect(sent).toMatchObject({
    amount: 125050,
    currency: "NGN",
    subaccount: api.code,
    transaction_charge: 0,
    bearer: "subaccount",
    metadata: { invoice_id: invoice.id },
  });
  const checkout = (await database.query.paymentCheckouts.findFirst({
    where: eq(schema.paymentCheckouts.invoiceId, invoice.id),
  }))!;
  expect(checkout).toMatchObject({
    subaccountCode: api.code,
    feeBearer: "subaccount",
    amountKobo: 125050,
    mode: "test",
  });
  await expect(
    client`UPDATE payment_checkouts SET subaccount_code = 'ACCT_other' WHERE reference = ${checkout.reference}`,
  ).rejects.toThrow("immutable");
  await expect(
    client`DELETE FROM payout_accounts WHERE user_id = ${id}`,
  ).rejects.toThrow("cannot be deleted");
  await expect(
    client`UPDATE payout_accounts SET bank_code = '044' WHERE user_id = ${id}`,
  ).rejects.toThrow("cannot be changed");
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, invoice.id));
  await expect(
    client`UPDATE invoices SET paystack_routing_required = false WHERE id = ${invoice.id}`,
  ).rejects.toThrow("cannot be changed");
  const charge: PaystackCharge = {
    reference: checkout.reference,
    amount: 125050,
    currency: "NGN",
    status: "success",
    paid_at: "2026-01-02T00:00:00Z",
    metadata: { invoice_id: invoice.id },
    domain: "test",
    subaccount: { subaccount_code: api.code },
  };
  for (const change of [
    { domain: "live" as const },
    { subaccount: { subaccount_code: "ACCT_wrong" } },
    { reference: "unknown-reference" },
    { amount: 1 },
    { subaccount: null },
  ])
    await expect(
      recordPaystackPayment(database, { ...charge, ...change }),
    ).rejects.toThrow();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => recordPaystackPayment(database, charge)),
  );
  expect(results.filter((r) => r === "recorded")).toHaveLength(1);
  const { createWebhooksRouter } = await import("../../src/routes/webhooks");
  const webhooks = createWebhooksRouter(database);
  const deliver = (data: PaystackCharge) => {
    const body = JSON.stringify({ event: "charge.success", data });
    return webhooks.request("/paystack", {
      method: "POST",
      body,
      headers: {
        "x-paystack-signature": createHmac(
          "sha512",
          process.env.PAYSTACK_SECRET_KEY!,
        )
          .update(body)
          .digest("hex"),
      },
    });
  };
  expect((await deliver(charge)).status).toBe(200);
  expect((await deliver({ ...charge, domain: "live" })).status).toBe(422);
  expect(
    (
      await database.query.invoices.findFirst({
        where: eq(schema.invoices.id, invoice.id),
      })
    )?.status,
  ).toBe("paid");
});

test("another freelancer cannot attach their payout routing to an invoice", async () => {
  const id = await owner(),
    other = await owner(),
    api = provider(),
    invoice = await draft(other);
  await setupPayoutAccount(database, id, input, api.request);
  await expect(
    database.transaction((tx) =>
      initializeInvoiceCheckout(
        tx,
        id,
        invoice,
        "payer@example.test",
        api.request,
      ),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(api.calls.some((c) => c.path === "/transaction/initialize")).toBe(
    false,
  );
  const account = (await database.query.payoutAccounts.findFirst({
    where: eq(schema.payoutAccounts.userId, id),
  }))!;
  await expect(
    client`INSERT INTO payment_checkouts(reference,invoice_id,payout_account_id,subaccount_code,mode,amount_kobo,fee_bearer) VALUES (${randomUUID()},${invoice.id},${account.id},${api.code},'test',125050,'subaccount')`,
  ).rejects.toThrow("does not match its invoice owner");
  expect(
    await database.query.paymentCheckouts.findFirst({
      where: eq(schema.paymentCheckouts.invoiceId, invoice.id),
    }),
  ).toBeUndefined();
});

test("payout routes require verified sessions, isolate owners, validate inputs, and paginate banks", async () => {
  const { createPayoutsRouter } = await import("../../src/routes/payouts");
  const { createSession } = await import("../../src/lib/sessions");
  const id = await owner(),
    other = await owner(),
    api = provider();
  await setupPayoutAccount(database, other, input, api.request);
  const session = await createSession(database, id);
  const headers = {
    Cookie: `access_token=${session.accessToken}`,
    "Content-Type": "application/json",
  };
  const router = createPayoutsRouter(database, (async (
    url: string | URL | Request,
  ) => {
    expect(new URL(String(url)).searchParams.get("next")).toBe("next-page");
    return Response.json({
      status: true,
      data: [
        { name: "Bank", code: "058", active: true },
        { name: "Closed", code: "044", active: false },
      ],
      meta: { next: null },
    });
  }) as typeof fetch);
  expect((await router.request("/account")).status).toBe(401);
  expect(await (await router.request("/account", { headers })).json()).toEqual({
    data: null,
    mode: "test",
  });
  expect(
    (
      await router.request("/account", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, userId: other }),
      })
    ).status,
  ).toBe(400);
  const banks = await router.request("/banks?next=next-page", { headers });
  expect(banks.headers.get("Cache-Control")).toBe("no-store");
  expect(await banks.json()).toEqual({
    data: [{ name: "Bank", code: "058" }],
    next: null,
  });
  await database
    .update(schema.users)
    .set({ emailVerifiedAt: null })
    .where(eq(schema.users.id, id));
  expect((await router.request("/account", { headers })).status).toBe(403);
});

test("key rotation blocks using a payout account from the previous provider credentials", async () => {
  const id = await owner(),
    api = provider(),
    invoice = await draft(id);
  await setupPayoutAccount(database, id, input, api.request);
  const key = process.env.PAYSTACK_SECRET_KEY;
  try {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_rotated_fixture";
    await expect(
      database.transaction((tx) =>
        initializeInvoiceCheckout(
          tx,
          id,
          invoice,
          "payer@example.test",
          api.request,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setupPayoutAccount(database, id, input, api.request),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    process.env.PAYSTACK_SECRET_KEY = key;
  }
});

test("invoice sending rolls back on provider failure, then issues one routed checkout and queued email", async () => {
  const { createInvoicesRouter } = await import("../../src/routes/invoices");
  const { createSession } = await import("../../src/lib/sessions");
  const id = await owner(),
    api = provider(),
    invoice = await draft(id);
  const session = await createSession(database, id);
  const headers = { Cookie: `access_token=${session.accessToken}` };
  let failCheckout = true;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (
      new URL(String(url)).pathname === "/transaction/initialize" &&
      failCheckout
    )
      return Response.json({ status: false }, { status: 503 });
    return api.request(url, init);
  }) as typeof fetch;
  const router = createInvoicesRouter(
    database,
    undefined,
    undefined,
    (tx, userId, draft, email) =>
      initializeInvoiceCheckout(tx, userId, draft, email, request),
  );
  const send = () =>
    router.request(`/${invoice.id}/send`, { method: "POST", headers });
  expect((await send()).status).toBe(409);
  await setupPayoutAccount(database, id, input, api.request);
  expect((await send()).status).toBe(502);
  expect(
    (
      await database.query.invoices.findFirst({
        where: eq(schema.invoices.id, invoice.id),
      })
    )?.status,
  ).toBe("draft");
  expect(
    await database.query.paymentCheckouts.findFirst({
      where: eq(schema.paymentCheckouts.invoiceId, invoice.id),
    }),
  ).toBeUndefined();
  expect(
    await database.query.emailJobs.findFirst({
      where: eq(schema.emailJobs.invoiceId, invoice.id),
    }),
  ).toBeUndefined();
  failCheckout = false;
  const responses = await Promise.all([send(), send()]);
  expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
  expect(
    await database.query.paymentCheckouts.findMany({
      where: eq(schema.paymentCheckouts.invoiceId, invoice.id),
    }),
  ).toHaveLength(1);
  expect(
    await database.query.emailJobs.findMany({
      where: eq(schema.emailJobs.invoiceId, invoice.id),
    }),
  ).toHaveLength(1);
});
