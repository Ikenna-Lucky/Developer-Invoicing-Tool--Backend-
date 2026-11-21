import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db";
import { invoices, payments } from "../db/schema";

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
