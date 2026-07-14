import { Hono } from "hono";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

import { db } from "../db";
import { invoices, payments } from "../db/schema";

const webhooksRouter = new Hono();

interface PaystackChargeSuccessData {
  id: number;
  reference: string;
  amount: number; // in kobo
  paid_at: string;
  status: string;
  currency: string;
  channel: string;
  customer: { email: string; customer_code: string };
  metadata: {
    invoice_id?: string;
    invoice_number?: string;
    client_name?: string;
    [key: string]: unknown;
  };
}

interface PaystackTransferSuccessData {
  id: number;
  amount: number; // in kobo
  reference: string;
  transfer_code: string;
  status: string;
  reason: string;
  currency: string;
  transferred_at: string;
  recipient: {
    name: string;
    account_number: string;
    bank_name: string;
  };
}

interface PaystackInvoicePaymentFailedData {
  domain: string;
  invoice_code: string;
  amount: number; // in kobo
  period_start: string;
  period_end: string;
  subscription: {
    status: string;
    subscription_code: string;
    email_token: string;
  };
  customer: { email: string };
}

type PaystackEvent =
  | { event: "charge.success"; data: PaystackChargeSuccessData }
  | { event: "transfer.success"; data: PaystackTransferSuccessData }
  | { event: "invoice.payment_failed"; data: PaystackInvoicePaymentFailedData }
  | { event: string; data: unknown };

function verifyPaystackSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expectedHash = createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");
  return expectedHash === signature;
}

// Fired when a customer completes a payment. Looks up the invoice via
// metadata.invoice_id, marks it paid, and records the payment.
async function handleChargeSuccess(
  data: PaystackChargeSuccessData,
): Promise<void> {
  const invoiceId = data.metadata?.invoice_id;

  if (!invoiceId) {
    console.warn(
      "[Webhook] charge.success — no invoice_id in metadata. Reference:",
      data.reference,
    );
    return;
  }

  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.id, invoiceId),
  });

  if (!invoice) {
    console.warn("[Webhook] charge.success — invoice not found:", invoiceId);
    return;
  }

  // idempotency — skip if already marked paid
  if (invoice.status === "paid") {
    console.log("[Webhook] charge.success — invoice already paid:", invoiceId);
    return;
  }

  // skip duplicate events for the same Paystack reference
  const existingPayment = await db.query.payments.findFirst({
    where: eq(payments.stripePaymentId, data.reference),
  });

  if (existingPayment) {
    console.log(
      "[Webhook] charge.success — duplicate event, already recorded. Reference:",
      data.reference,
    );
    return;
  }

  const amountPaid = (data.amount / 100).toFixed(2); // kobo → NGN

  await Promise.all([
    db
      .update(invoices)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId)),

    db.insert(payments).values({
      id: randomUUID(),
      invoiceId,
      amountPaid,
      paidAt: new Date(data.paid_at),
      stripePaymentId: data.reference, // column stores the Paystack reference
      createdAt: new Date(),
    }),
  ]);

  console.log(
    `[Webhook] charge.success — invoice ${invoice.invoiceNumber} marked as paid. ` +
      `Amount: ₦${amountPaid}. Reference: ${data.reference}`,
  );
}

// Fired when a payout from the Paystack balance completes. No invoice is
// affected — just logged for now.
async function handleTransferSuccess(
  data: PaystackTransferSuccessData,
): Promise<void> {
  const amountNGN = (data.amount / 100).toFixed(2);
  console.log(
    `[Webhook] transfer.success — ₦${amountNGN} transferred to ` +
      `${data.recipient?.name ?? "recipient"} (${data.recipient?.account_number ?? "N/A"}). ` +
      `Code: ${data.transfer_code}. Ref: ${data.reference}`,
  );
  // could notify ourselves here, or persist a transfers log table later
}

// Fired when a Paystack subscription invoice payment fails. Just logged for
// now — extend to flip the invoice to "overdue" if subscriptions get added.
async function handleInvoicePaymentFailed(
  data: PaystackInvoicePaymentFailedData,
): Promise<void> {
  const amountNGN = (data.amount / 100).toFixed(2);
  console.warn(
    `[Webhook] invoice.payment_failed — ` +
      `Customer: ${data.customer?.email ?? "unknown"}. ` +
      `Invoice code: ${data.invoice_code}. ` +
      `Amount: ₦${amountNGN}. ` +
      `Subscription: ${data.subscription?.subscription_code ?? "N/A"}`,
  );
}

// POST /webhooks/paystack — must return 200 quickly or Paystack retries.
// Signature is verified before anything else runs.
webhooksRouter.post("/paystack", async (c) => {
  // raw body is needed before JSON parsing for the HMAC check
  const rawBody = await c.req.text();

  const signature = c.req.header("x-paystack-signature");
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    console.error("[Webhook] PAYSTACK_SECRET_KEY is not set");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  if (!signature || !verifyPaystackSignature(rawBody, signature, secret)) {
    console.warn("[Webhook] Invalid signature — possible spoofed request");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: PaystackEvent;
  try {
    payload = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const { event, data } = payload;
  console.log(`[Webhook] Received event: ${event}`);

  // always return 200 to Paystack even if handling fails below
  try {
    switch (event) {
      case "charge.success":
        await handleChargeSuccess(data as PaystackChargeSuccessData);
        break;

      case "transfer.success":
        await handleTransferSuccess(data as PaystackTransferSuccessData);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(
          data as PaystackInvoicePaymentFailedData,
        );
        break;

      default:
        console.log(`[Webhook] Unhandled event type: ${event} — ignoring`);
    }
  } catch (err) {
    console.error(`[Webhook] Error processing event "${event}":`, err);
  }

  return c.json({ received: true });
});

export default webhooksRouter;
