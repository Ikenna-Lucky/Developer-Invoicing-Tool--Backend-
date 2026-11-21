import { beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { DB } from "../src/db";
import { paystackChargeSchema } from "../src/lib/payments";

const secret = "test-paystack-secret";
let createRouter: typeof import("../src/routes/webhooks").createWebhooksRouter;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.PAYSTACK_SECRET_KEY = secret;
  createRouter = (await import("../src/routes/webhooks")).createWebhooksRouter;
});

const charge = {
  reference: "BILLD-test-reference",
  amount: 125050,
  paid_at: "2026-11-21T10:00:00.000Z",
  status: "success",
  currency: "NGN",
  metadata: { invoice_id: "ba464539-627a-453e-8e65-7c4c697d1e04" },
};

function request(body: string, signature?: string) {
  return new Request("http://localhost/paystack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature === undefined ? {} : { "x-paystack-signature": signature }),
    },
    body,
  });
}

function sign(body: string) {
  return createHmac("sha512", secret).update(body).digest("hex");
}

describe("Paystack webhook boundaries", () => {
  test("rejects missing, malformed, and incorrect signatures before database access", async () => {
    const router = createRouter({} as DB);
    const body = JSON.stringify({ event: "charge.success", data: charge });
    for (const signature of [undefined, "bad", "0".repeat(128)]) {
      expect((await router.fetch(request(body, signature))).status).toBe(401);
    }
  });

  test("rejects tampering with a signed payload", async () => {
    const original = JSON.stringify({ event: "charge.success", data: charge });
    const tampered = original.replace("125050", "1");
    expect(
      (await createRouter({} as DB).fetch(request(tampered, sign(original))))
        .status,
    ).toBe(401);
  });

  test("rejects malformed JSON, envelopes, and charge data", async () => {
    const router = createRouter({} as DB);
    for (const body of [
      "{",
      "null",
      "{}",
      JSON.stringify({ event: "charge.success", data: {} }),
    ]) {
      expect((await router.fetch(request(body, sign(body)))).status).toBe(400);
    }
  });

  test("acknowledges unrelated events without database access", async () => {
    const body = JSON.stringify({ event: "unhandled.event", data: {} });
    expect(
      (await createRouter({} as DB).fetch(request(body, sign(body)))).status,
    ).toBe(200);
  });

  test("returns a retryable error when the database fails", async () => {
    const database = {
      transaction: async () => {
        throw new Error("Database unavailable");
      },
    } as unknown as DB;
    const body = JSON.stringify({ event: "charge.success", data: charge });
    const response = await createRouter(database).fetch(
      request(body, sign(body)),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Payment processing failed",
    });
  });
});

test("charge validation rejects fractional kobo, unsafe integers, invalid dates, and unsuccessful charges", () => {
  for (const changes of [
    { amount: 1.5 },
    { amount: 0 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { paid_at: "not-a-date" },
    { status: "failed" },
    { reference: "" },
  ]) {
    expect(
      paystackChargeSchema.safeParse({ ...charge, ...changes }).success,
    ).toBe(false);
  }
});
