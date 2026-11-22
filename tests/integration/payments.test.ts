import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import {
  recordPaystackPayment,
  recordOfflinePayment,
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

async function fixture(userId = randomUUID()) {
  const clientId = randomUUID(),
    invoiceId = randomUUID();
  await database
    .insert(schema.users)
    .values({
      id: userId,
      email: `${userId}@example.test`,
      fullName: "Test Sender",
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing();
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
  return { userId, invoiceId, charge };
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

const offline = {
  amount: "1250.50",
  paidAt: "2026-01-02T10:00:00Z",
  method: "bank_transfer" as const,
  reference: "bank receipt 123",
};

test("offline retries record one immutable payment with the actor and one audit event", async () => {
  const { userId, invoiceId } = await fixture();
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      recordOfflinePayment(database, userId, invoiceId, key, offline),
    ),
  );
  expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
  const { payments, invoice } = await saved(invoiceId);
  expect(invoice?.status).toBe("paid");
  expect(payments).toHaveLength(1);
  expect(payments[0].recordedBy).toBe(userId);
  expect(payments[0].method).toBe("bank_transfer");
  expect(payments[0].reference).toBe(offline.reference);
  expect(payments[0].idempotencyKey).not.toBe(key);
  const history = await database.query.auditEvents.findMany({
    where: eq(schema.auditEvents.resourceId, payments[0].id),
  });
  expect(history).toHaveLength(1);
  await expect(
    client`UPDATE payments SET amount_paid = 1 WHERE id = ${payments[0].id}`,
  ).rejects.toThrow("cannot be changed");
  await expect(
    client`DELETE FROM payments WHERE id = ${payments[0].id}`,
  ).rejects.toThrow("cannot be changed");
});

test("offline key reuse with changed input or another invoice conflicts", async () => {
  const first = await fixture();
  const key = randomUUID();
  await recordOfflinePayment(
    database,
    first.userId,
    first.invoiceId,
    key,
    offline,
  );
  for (const change of [
    { amount: "1" },
    { method: "cash" as const },
    { reference: "another receipt" },
    { paidAt: "2026-01-03T10:00:00Z" },
  ]) {
    await expect(
      recordOfflinePayment(database, first.userId, first.invoiceId, key, {
        ...offline,
        ...change,
      }),
    ).rejects.toThrow("different payment");
  }
  const second = await fixture(first.userId);
  await expect(
    recordOfflinePayment(
      database,
      first.userId,
      second.invoiceId,
      key,
      offline,
    ),
  ).rejects.toThrow("different payment");
});

test("offline payment validation and ownership leave no financial changes", async () => {
  const { userId, invoiceId } = await fixture();
  for (const input of [
    { ...offline, amount: "1" },
    { ...offline, paidAt: "2099-01-01T00:00:00Z" },
  ])
    await expect(
      recordOfflinePayment(database, userId, invoiceId, randomUUID(), input),
    ).rejects.toThrow();
  await expect(
    recordOfflinePayment(
      database,
      randomUUID(),
      invoiceId,
      randomUUID(),
      offline,
    ),
  ).rejects.toThrow("not found");
  await expect(
    recordOfflinePayment(database, userId, invoiceId, "short", offline),
  ).rejects.toThrow("Idempotency-Key");
  expect((await saved(invoiceId)).payments).toHaveLength(0);
  expect((await saved(invoiceId)).invoice?.status).toBe("sent");
});

test("offline and Paystack settlements race through the same invoice lock", async () => {
  const { userId, invoiceId, charge } = await fixture();
  const results = await Promise.allSettled([
    recordOfflinePayment(database, userId, invoiceId, randomUUID(), offline),
    recordPaystackPayment(database, charge),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await saved(invoiceId)).payments).toHaveLength(1);
});

test("draft, archived, and already-paid invoices cannot acquire an offline payment", async () => {
  for (const state of ["draft", "archived", "paid"]) {
    const { userId, invoiceId, charge } = await fixture();
    if (state === "draft") {
      // Construct a draft directly; issued invoices cannot move backwards.
      const draftId = randomUUID();
      const original = (await saved(invoiceId)).invoice!;
      await database
        .insert(schema.invoices)
        .values({
          ...original,
          id: draftId,
          invoiceNumber: draftId,
          status: "draft",
        });
      await expect(
        recordOfflinePayment(database, userId, draftId, randomUUID(), offline),
      ).rejects.toThrow("unpaid issued");
      await expect(
        recordPaystackPayment(database, {
          ...charge,
          metadata: { invoice_id: draftId },
        }),
      ).rejects.toThrow("unpaid issued");
    } else {
      if (state === "archived")
        await database
          .update(schema.invoices)
          .set({ deletedAt: new Date() })
          .where(eq(schema.invoices.id, invoiceId));
      else await recordPaystackPayment(database, charge);
      await expect(
        recordOfflinePayment(
          database,
          userId,
          invoiceId,
          randomUUID(),
          offline,
        ),
      ).rejects.toThrow();
    }
  }
});

test("offline insert rolls back when the paid status update fails", async () => {
  const { userId, invoiceId } = await fixture();
  await client.unsafe(
    `CREATE FUNCTION reject_offline_paid() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${invoiceId}' AND NEW.status = 'paid' THEN RAISE EXCEPTION 'injected update failure'; END IF; RETURN NEW; END $$`,
  );
  await client.unsafe(
    "CREATE TRIGGER test_offline_failure BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION reject_offline_paid()",
  );
  const key = randomUUID();
  try {
    await expect(
      recordOfflinePayment(database, userId, invoiceId, key, offline),
    ).rejects.toThrow("injected update failure");
    expect((await saved(invoiceId)).payments).toHaveLength(0);
  } finally {
    await client.unsafe(
      "DROP TRIGGER test_offline_failure ON invoices; DROP FUNCTION reject_offline_paid()",
    );
  }
  expect(
    (await recordOfflinePayment(database, userId, invoiceId, key, offline))
      .duplicate,
  ).toBe(false);
});

test("payment API validates sessions, owner access, history, and reconciliation replay", async () => {
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET =
    "payment-tests-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "payment-tests-refresh-secret-at-least-32-bytes";
  const { createInvoicesRouter } = await import("../../src/routes/invoices");
  const { createSession } = await import("../../src/lib/sessions");
  const { Hono } = await import("hono");
  const { HTTPException } = await import("hono/http-exception");
  const first = await fixture(),
    second = await fixture();
  const session = await createSession(database, first.userId);
  const headers = {
    Cookie: `access_token=${session.accessToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  };
  let verifications = 0;
  let verifiedCharge = first.charge;
  const app = new Hono();
  app.route(
    "/",
    createInvoicesRouter(database, undefined, async () => {
      verifications++;
      return verifiedCharge;
    }),
  );
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof HTTPException ? error.status : 500,
    ),
  );
  expect((await app.request(`/${first.invoiceId}/payments`)).status).toBe(401);
  expect(
    (await app.request(`/${second.invoiceId}/payments`, { headers })).status,
  ).toBe(404);
  expect(
    (
      await app.request(`/${second.invoiceId}/payments/reconcile`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reference: first.charge.reference }),
      })
    ).status,
  ).toBe(404);
  expect(verifications).toBe(0);
  const reconcile = () =>
    app.request(`/${first.invoiceId}/payments/reconcile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reference: first.charge.reference }),
    });
  verifiedCharge = second.charge;
  expect((await reconcile()).status).toBe(422);
  expect((await saved(first.invoiceId)).payments).toHaveLength(0);
  verifiedCharge = { ...first.charge, amount: 1 };
  expect((await reconcile()).status).toBe(409);
  verifiedCharge = first.charge;
  expect((await reconcile()).status).toBe(200);
  expect(await (await reconcile()).json()).toEqual({ result: "duplicate" });
  const history = await (
    await app.request(`/${first.invoiceId}/payments`, { headers })
  ).json();
  expect(history.data).toHaveLength(1);
  expect(history.data[0]).not.toHaveProperty("idempotencyKey");
  for (let attempt = 0; attempt < 6; attempt++)
    expect((await reconcile()).status).toBe(200);
  const limited = await reconcile();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBeTruthy();
  expect(verifications).toBe(10);
  const manual = await fixture();
  const manualSession = await createSession(database, manual.userId);
  const manualHeaders = {
    ...headers,
    Cookie: `access_token=${manualSession.accessToken}`,
  };
  const record = () =>
    app.request(`/${manual.invoiceId}/payments`, {
      method: "POST",
      headers: manualHeaders,
      body: JSON.stringify(offline),
    });
  expect((await record()).status).toBe(201);
  expect((await record()).status).toBe(200);
  expect(
    (
      await app.request(`/${manual.invoiceId}/payments`, {
        method: "POST",
        headers: manualHeaders,
        body: JSON.stringify({ ...offline, method: "cash" }),
      })
    ).status,
  ).toBe(409);
  expect((await app.request(`/bad-id/payments`, { headers })).status).toBe(400);
});

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
