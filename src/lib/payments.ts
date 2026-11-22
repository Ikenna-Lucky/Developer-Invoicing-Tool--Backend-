import { randomUUID, createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db";
import { invoices, payments } from "../db/schema";
import { lockOwnedInvoice } from "./invoices";

export const paystackChargeSchema = z.object({
  reference: z.string().min(1).max(200),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  paid_at: z.string().datetime({ offset: true }),
  status: z.literal("success"),
  currency: z.string(),
  metadata: z.unknown().optional(),
});

export type PaystackCharge = z.infer<typeof paystackChargeSchema>;

export class PaymentConflict extends Error {}

function amountInKobo(amount: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new PaymentConflict("Invoice amount is invalid");
  }
  const [naira, fraction = ""] = amount.split(".");
  const kobo = Number(naira) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(kobo)) {
    throw new PaymentConflict("Invoice amount exceeds the supported range");
  }
  return kobo;
}

export const offlinePaymentSchema = z
  .object({
    amount: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
    paidAt: z.string().datetime({ offset: true }),
    method: z.enum(["cash", "bank_transfer", "other"]),
    reference: z.string().trim().min(1).max(200),
  })
  .strict();

export async function recordOfflinePayment(
  database: DB,
  userId: string,
  invoiceId: string,
  key: string,
  input: z.infer<typeof offlinePaymentSchema>,
) {
  const parsed = offlinePaymentSchema.parse(input);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
    throw new HTTPException(400, {
      message: "A 16–128 character Idempotency-Key is required",
    });
  const amount = amountInKobo(parsed.amount);
  const paidAt = new Date(parsed.paidAt);
  if (amount <= 0 || paidAt.getTime() > Date.now())
    throw new HTTPException(400, {
      message:
        "Payment amount must be positive and payment date cannot be in the future",
    });
  // Scope keys to the account without retaining the caller's raw key.
  const scopedKey = createHash("sha256")
    .update(`${userId}:${key}`)
    .digest("hex");
  return database.transaction(async (tx) => {
    // Serialize reuse across different invoices as well as retries for one invoice.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopedKey}, 0))`,
    );
    const invoice = await lockOwnedInvoice(tx, userId, invoiceId);
    const existing = await tx.query.payments.findFirst({
      where: eq(payments.idempotencyKey, scopedKey),
    });
    if (existing) {
      if (
        existing.invoiceId !== invoiceId ||
        amountInKobo(existing.amountPaid) !== amount ||
        existing.paidAt.getTime() !== paidAt.getTime() ||
        existing.method !== parsed.method ||
        existing.reference !== parsed.reference
      )
        throw new HTTPException(409, {
          message: "Idempotency key was already used for a different payment",
        });
      return { payment: existing, duplicate: true };
    }
    const previous = await tx.query.payments.findFirst({
      where: eq(payments.invoiceId, invoiceId),
    });
    if (previous || !["sent", "overdue"].includes(invoice.status))
      throw new HTTPException(409, {
        message: "Only unpaid issued invoices can receive an offline payment",
      });
    if (amount !== amountInKobo(invoice.totalAmount))
      throw new HTTPException(409, {
        message: "Payment must match the full invoice amount",
      });
    const [payment] = await tx
      .insert(payments)
      .values({
        id: randomUUID(),
        invoiceId,
        amountPaid: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`,
        paidAt,
        method: parsed.method,
        reference: parsed.reference,
        recordedBy: userId,
        idempotencyKey: scopedKey,
      })
      .returning();
    await tx
      .update(invoices)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    return { payment, duplicate: false };
  });
}

export async function recordPaystackPayment(
  database: DB,
  charge: PaystackCharge,
): Promise<"recorded" | "duplicate" | "ignored"> {
  const metadata = z
    .object({ invoice_id: z.string().uuid() })
    .safeParse(charge.metadata);
  // The Paystack account may also receive payments unrelated to Billd.
  if (!metadata.success) {
    if (
      charge.metadata &&
      typeof charge.metadata === "object" &&
      "invoice_id" in charge.metadata
    ) {
      throw new PaymentConflict("Payment invoice metadata is invalid");
    }
    return "ignored";
  }
  const invoiceId = metadata.data.invoice_id;

  return database.transaction(async (tx) => {
    // Serialize payments for this invoice across requests and API instances.
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update");
    if (!invoice) throw new PaymentConflict("Payment invoice was not found");

    if (
      charge.currency !== "NGN" ||
      charge.amount !== amountInKobo(invoice.totalAmount)
    ) {
      throw new PaymentConflict(
        "Payment amount or currency does not match the invoice",
      );
    }

    const existing = await tx.query.payments.findFirst({
      where: eq(payments.stripePaymentId, charge.reference),
    });
    if (existing) {
      if (
        existing.invoiceId !== invoiceId ||
        amountInKobo(existing.amountPaid) !== charge.amount
      ) {
        throw new PaymentConflict(
          "Payment reference is already assigned to another payment",
        );
      }
      return "duplicate";
    }

    const previousPayment = await tx.query.payments.findFirst({
      where: eq(payments.invoiceId, invoiceId),
    });
    if (previousPayment) {
      throw new PaymentConflict("Invoice already has a different payment");
    }
    if (!["sent", "overdue"].includes(invoice.status))
      throw new PaymentConflict(
        "Only unpaid issued invoices can receive a payment",
      );

    const amountPaid = `${Math.floor(charge.amount / 100)}.${String(charge.amount % 100).padStart(2, "0")}`;
    await tx.insert(payments).values({
      id: randomUUID(),
      invoiceId,
      amountPaid,
      paidAt: new Date(charge.paid_at),
      stripePaymentId: charge.reference,
    });
    await tx
      .update(invoices)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));
    return "recorded";
  });
}
