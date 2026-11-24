import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { paystackChargeSchema } from "./payments";

export async function verifyPaystackPayment(
  reference: string,
  request: typeof fetch = fetch,
) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret)
    throw new HTTPException(503, {
      message: "Payment verification is not configured",
    });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await request(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("Verification request failed");
    const result = z
      .object({ status: z.literal(true), data: z.unknown() })
      .safeParse(await response.json());
    if (!result.success) throw new Error("Invalid verification response");
    const charge = paystackChargeSchema.safeParse(result.data.data);
    if (!charge.success || charge.data.reference !== reference)
      throw new HTTPException(422, {
        message: "Reference does not identify a valid successful payment",
      });
    return charge.data;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(502, {
      message: "Could not verify payment. Please try again later",
    });
  } finally {
    clearTimeout(timeout);
  }
}
