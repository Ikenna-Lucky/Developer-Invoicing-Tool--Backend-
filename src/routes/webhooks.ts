import { reportError } from "../lib/observability";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { db, type DB } from "../db";
import {
  paystackChargeSchema,
  PaymentConflict,
  recordPaystackPayment,
} from "../lib/payments";

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
      reportError("paystack.not_configured");
      return c.json({ error: "Webhook not configured" }, 500);
    }

    if (!signature || !verifyPaystackSignature(rawBody, signature, secret)) {
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

    try {
      switch (event) {
        case "charge.success": {
          const charge = paystackChargeSchema.safeParse(data);
          if (!charge.success)
            return c.json({ error: "Invalid charge payload" }, 400);
          await recordPaystackPayment(database, charge.data);
          break;
        }

        default:
          break;
      }
    } catch (err) {
      if (err instanceof PaymentConflict) {
        return c.json({ error: err.message }, 422);
      }
      reportError("paystack.webhook_failed", err);
      return c.json({ error: "Payment processing failed" }, 500);
    }

    return c.json({ received: true });
  });

  return webhooksRouter;
}

const eventSchema = z.object({ event: z.string().min(1), data: z.unknown() });

export default createWebhooksRouter();
