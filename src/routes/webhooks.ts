import { Hono } from "hono";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

import { db } from "../db";
import { invoices, payments } from "../db/schema";

const webhooksRouter = new Hono();

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Signature Verification ────────────────────────────────────────────────────

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

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * charge.success
 * Fired when a customer completes a payment.
 * We look up the invoice via metadata.invoice_id, mark it as paid,
 * and record the payment in the payments table.
 */
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

  // Look up the invoice
  const invoice = await db.query.invoices.findFirst({
    where: eq(invoices.id, invoiceId),
  });

  if (!invoice) {
    console.warn("[Webhook] charge.success — invoice not found:", invoiceId);
    return;
  }

  // Idempotency: skip if already marked paid
  if (invoice.status === "paid") {
    console.log("[Webhook] charge.success — invoice already paid:", invoiceId);
    return;
  }

  // Check for duplicate payment record (same Paystack reference)
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

  // Convert kobo → NGN
  const amountPaid = (data.amount / 100).toFixed(2);

  // Run both writes together
  await Promise.all([
    // Mark invoice as paid
    db
      .update(invoices)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId)),

    // Record the payment
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

/**
 * transfer.success
 * Fired when a payout from your Paystack balance completes.
 * No invoice is affected; we just log it for your records.
 */
async function handleTransferSuccess(
  data: PaystackTransferSuccessData,
): Promise<void> {
  const amountNGN = (data.amount / 100).toFixed(2);
  console.log(
    `[Webhook] transfer.success — ₦${amountNGN} transferred to ` +
      `${data.recipient?.name ?? "recipient"} (${data.recipient?.account_number ?? "N/A"}). ` +
      `Code: ${data.transfer_code}. Ref: ${data.reference}`,
  );
  // You can extend this to notify yourself (e.g. send an internal email)
  // or persist a transfers log table in the future.
}

/**
 * invoice.payment_failed
 * Fired when a Paystack subscription invoice payment fails.
 * We log the failure. If you later add subscription support you can
 * extend this to flip the invoice to "overdue" or notify the client.
 */
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
  // Extend here: look up an invoice linked to this subscription and
  // flip its status to "overdue", or fire a retry-payment email.
}

// ─── POST /webhooks/paystack ──────────────────────────────────────────────────
// Receives all Paystack webhook events. Must return 200 quickly or Paystack
// will retry. Signature is verified before any processing occurs.

webhooksRouter.post("/paystack", async (c) => {
  // ── 1. Read raw body (needed before any JSON parsing for HMAC) ─────────────
  const rawBody = await c.req.text();

  // ── 2. Verify Paystack signature ───────────────────────────────────────────
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

  // ── 3. Parse event payload ─────────────────────────────────────────────────
  let payload: PaystackEvent;
  try {
    payload = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const { event, data } = payload;
  console.log(`[Webhook] Received event: ${event}`);

  // ── 4. Dispatch to handler (non-blocking — always return 200 to Paystack) ──
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
    // Log processing errors but still return 200 so Paystack doesn't retry
    console.error(`[Webhook] Error processing event "${event}":`, err);
  }

  // ── 5. Acknowledge receipt ─────────────────────────────────────────────────
  return c.json({ received: true });
});

export default webhooksRouter;
