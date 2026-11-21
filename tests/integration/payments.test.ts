import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import {
  recordPaystackPayment,
  type PaystackCharge,
} from "../../src/lib/payments";

const context = createTestDatabase();
const { client, database } = context;
beforeAll(async () => {
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}, 30_000);
afterAll(async () => {
  await context.close();
});

async function fixture() {
  const userId = randomUUID(),
    clientId = randomUUID(),
    invoiceId = randomUUID();
  await database.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.test`,
    fullName: "Test Sender",
  });
  await database.insert(schema.clients).values({
    id: clientId,
    userId,
    name: "Test Client",
    email: "client@example.test",
  });
  await database.insert(schema.invoices).values({
    id: invoiceId,
    userId,
    clientId,
    invoiceNumber: `TEST-${invoiceId}`,
    status: "sent",
    issueDate: new Date(),
    dueDate: new Date(),
    totalAmount: "1250.50",
  });
  const charge: PaystackCharge = {
    reference: `BILLD-${randomUUID()}`,
    amount: 125050,
    paid_at: "2026-11-21T10:00:00.000Z",
    status: "success",
    currency: "NGN",
    metadata: { invoice_id: invoiceId },
  };
  return { invoiceId, charge };
}

async function saved(invoiceId: string) {
  return {
    invoice: await database.query.invoices.findFirst({
      where: eq(schema.invoices.id, invoiceId),
    }),
    payments: await database.query.payments.findMany({
      where: eq(schema.payments.invoiceId, invoiceId),
    }),
  };
}

test("records the exact payment and marks the invoice paid", async () => {
  const { invoiceId, charge } = await fixture();
  expect(await recordPaystackPayment(database, charge)).toBe("recorded");
  const result = await saved(invoiceId);
  expect(result.invoice?.status).toBe("paid");
  expect(result.payments).toHaveLength(1);
  expect(result.payments[0].amountPaid).toBe("1250.50");
  expect(result.payments[0].stripePaymentId).toBe(charge.reference);
});

test("simultaneous duplicate events create one payment", async () => {
  const { invoiceId, charge } = await fixture();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => recordPaystackPayment(database, charge)),
  );
  expect(results.filter((result) => result === "recorded")).toHaveLength(1);
  expect(results.filter((result) => result === "duplicate")).toHaveLength(4);
  expect((await saved(invoiceId)).payments).toHaveLength(1);
});

test("rejects incorrect amounts and currencies without changing the invoice", async () => {
  const { invoiceId, charge } = await fixture();
  for (const changes of [
    { amount: 1 },
    { amount: 125051 },
    { currency: "USD" },
  ]) {
    await expect(
      recordPaystackPayment(database, { ...charge, ...changes }),
    ).rejects.toThrow("does not match");
  }
  const result = await saved(invoiceId);
  expect(result.invoice?.status).toBe("sent");
  expect(result.payments).toHaveLength(0);
});

test("rolls back the inserted payment if the invoice update fails", async () => {
  const { invoiceId, charge } = await fixture();
  await client.unsafe(`CREATE FUNCTION reject_paid_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = '${invoiceId}' AND NEW.status = 'paid' THEN
      RAISE EXCEPTION 'injected update failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(
    "CREATE TRIGGER test_reject_paid BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION reject_paid_update()",
  );
  try {
    await expect(recordPaystackPayment(database, charge)).rejects.toThrow(
      "injected update failure",
    );
    const result = await saved(invoiceId);
    expect(result.invoice?.status).toBe("sent");
    expect(result.payments).toHaveLength(0);
  } finally {
    await client.unsafe("DROP TRIGGER test_reject_paid ON invoices");
    await client.unsafe("DROP FUNCTION reject_paid_update()");
  }
  expect(await recordPaystackPayment(database, charge)).toBe("recorded");
});

test("rejects reuse of a payment reference on another invoice", async () => {
  const first = await fixture(),
    second = await fixture();
  await recordPaystackPayment(database, first.charge);
  await expect(
    recordPaystackPayment(database, {
      ...second.charge,
      reference: first.charge.reference,
    }),
  ).rejects.toThrow("already assigned");
  expect((await saved(second.invoiceId)).invoice?.status).toBe("sent");
  expect((await saved(second.invoiceId)).payments).toHaveLength(0);
});

test("does not silently discard a second payment reference for a paid invoice", async () => {
  const { invoiceId, charge } = await fixture();
  await recordPaystackPayment(database, charge);
  await expect(
    recordPaystackPayment(database, {
      ...charge,
      reference: `BILLD-${randomUUID()}`,
    }),
  ).rejects.toThrow("different payment");
  expect((await saved(invoiceId)).payments).toHaveLength(1);
});

test("concurrent distinct references cannot both settle the same invoice", async () => {
  const { invoiceId, charge } = await fixture();
  const results = await Promise.allSettled([
    recordPaystackPayment(database, charge),
    recordPaystackPayment(database, {
      ...charge,
      reference: `BILLD-${randomUUID()}`,
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect((await saved(invoiceId)).payments).toHaveLength(1);
});

test("signed webhook requests commit before returning success and acknowledge replays", async () => {
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.PAYSTACK_SECRET_KEY = "integration-signing-secret";
  const { createWebhooksRouter } = await import("../../src/routes/webhooks");
  const router = createWebhooksRouter(database);
  const { invoiceId, charge } = await fixture();
  const body = JSON.stringify({ event: "charge.success", data: charge });
  const signature = createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await router.request("/paystack", {
      method: "POST",
      body,
      headers: { "x-paystack-signature": signature },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    const result = await saved(invoiceId);
    expect(result.invoice?.status).toBe("paid");
    expect(result.payments).toHaveLength(1);
  }
});

test("signed mismatched payments return 422 without saving a payment", async () => {
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.PAYSTACK_SECRET_KEY = "integration-signing-secret";
  const { createWebhooksRouter } = await import("../../src/routes/webhooks");
  const { invoiceId, charge } = await fixture();
  const body = JSON.stringify({
    event: "charge.success",
    data: { ...charge, amount: 1 },
  });
  const signature = createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest("hex");
  const response = await createWebhooksRouter(database).request("/paystack", {
    method: "POST",
    body,
    headers: { "x-paystack-signature": signature },
  });
  expect(response.status).toBe(422);
  expect((await saved(invoiceId)).invoice?.status).toBe("sent");
  expect((await saved(invoiceId)).payments).toHaveLength(0);
});
