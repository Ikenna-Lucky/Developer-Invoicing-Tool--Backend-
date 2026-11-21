import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { db, type DB } from "../db";
import {
  paystackChargeSchema,
  PaymentConflict,
  recordPaystackPayment,
} from "../lib/payments";

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

function verifyPaystackSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expectedHash = createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");
  if (!/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    Buffer.from(signature, "hex"),
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
}

// Subscription payment failures are logged without changing Billd invoices.
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

export function createWebhooksRouter(database: DB = db) {
  const webhooksRouter = new Hono();

  // Acknowledge payment events only after the transaction commits.
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

    let payload: z.infer<typeof eventSchema>;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(rawBody));
      if (!parsed.success)
        return c.json({ error: "Invalid event payload" }, 400);
      payload = parsed.data;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const { event, data } = payload;
    console.log(`[Webhook] Received event: ${event}`);

    try {
      switch (event) {
        case "charge.success": {
          const charge = paystackChargeSchema.safeParse(data);
          if (!charge.success)
            return c.json({ error: "Invalid charge payload" }, 400);
          const result = await recordPaystackPayment(database, charge.data);
          console.log(`[Webhook] charge.success: ${result}`);
          break;
        }

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
      if (err instanceof PaymentConflict) {
        return c.json({ error: err.message }, 422);
      }
      return c.json({ error: "Payment processing failed" }, 500);
    }

    return c.json({ received: true });
  });

  return webhooksRouter;
}

const eventSchema = z.object({ event: z.string().min(1), data: z.unknown() });

export default createWebhooksRouter();
