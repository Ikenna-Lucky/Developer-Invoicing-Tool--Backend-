import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DB } from "../db";
import { invoices, paymentCheckouts, payoutAccounts } from "../db/schema";
import { paystackCredentials, paystackRequest } from "./payouts";

type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

export async function initializeInvoiceCheckout(
  tx: Transaction,
  userId: string,
  invoice: { id: string; totalAmount: string },
  email: string,
  request: typeof fetch = fetch,
) {
  const { mode, fingerprint } = paystackCredentials();
  const feeBearer = "subaccount";
  const [ownedInvoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoice.id), eq(invoices.userId, userId)))
    .for("update");
  if (
    !ownedInvoice ||
    ownedInvoice.status !== "draft" ||
    ownedInvoice.deletedAt ||
    !ownedInvoice.paystackRoutingRequired ||
    ownedInvoice.totalAmount !== invoice.totalAmount
  )
    throw new HTTPException(409, {
      message: "Checkout requires the owner's current draft invoice",
    });
  const account = await tx.query.payoutAccounts.findFirst({
    where: and(
      eq(payoutAccounts.userId, userId),
      eq(payoutAccounts.mode, mode),
    ),
  });
  if (
    !account ||
    account.status !== "ready" ||
    !account.subaccountCode ||
    account.keyFingerprint !== fingerprint
  )
    throw new HTTPException(409, {
      message:
        "Set up a payout account for this Paystack environment before sending payment links",
    });
  const remote = z
    .object({
      subaccount_code: z.literal(account.subaccountCode),
      domain: z.literal(mode),
      currency: z.literal("NGN"),
      active: z.literal(true),
    })
    .safeParse(
      await paystackRequest(
        `/subaccount/${encodeURIComponent(account.subaccountCode)}`,
        {},
        request,
      ),
    );
  if (!remote.success)
    throw new HTTPException(409, {
      message:
        "The payout subaccount is unavailable or belongs to another environment",
    });
  const [whole, fraction = ""] = invoice.totalAmount.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (
    !/^\d+(\.\d{1,2})?$/.test(invoice.totalAmount) ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  )
    throw new HTTPException(422, { message: "Invalid invoice payment amount" });
  const reference = `BILLD-SPLIT-${randomUUID()}`;
  const checkout = z
    .object({
      reference: z.literal(reference),
      authorization_url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname === "checkout.paystack.com" &&
          !url.username &&
          !url.password
        );
      }),
    })
    .safeParse(
      await paystackRequest(
        "/transaction/initialize",
        {
          method: "POST",
          body: JSON.stringify({
            email,
            amount,
            reference,
            currency: "NGN",
            subaccount: account.subaccountCode,
            transaction_charge: 0,
            bearer: feeBearer,
            metadata: { invoice_id: invoice.id },
          }),
        },
        request,
      ),
    );
  if (!checkout.success)
    throw new HTTPException(502, {
      message: "Paystack returned an invalid checkout",
    });
  await tx.insert(paymentCheckouts).values({
    reference,
    invoiceId: invoice.id,
    payoutAccountId: account.id,
    subaccountCode: account.subaccountCode,
    mode,
    amountKobo: amount,
    feeBearer,
  });
  return checkout.data.authorization_url;
}
