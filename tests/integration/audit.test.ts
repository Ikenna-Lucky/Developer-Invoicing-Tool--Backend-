import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import * as schema from "../../src/db/schema";
import {
  createDraftInvoice,
  changeInvoiceStatus,
} from "../../src/lib/invoices";
import { recordPaystackPayment } from "../../src/lib/payments";

const context = createTestDatabase();
const { client, database } = context;
beforeAll(async () => {
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}, 30_000);
afterAll(() => context.close());

async function fixture() {
  const ownerId = randomUUID(),
    clientId = randomUUID();
  await database.insert(schema.users).values({
    id: ownerId,
    email: `${ownerId}@secret.test`,
    passwordHash: "secret-password-hash",
    fullName: "secret owner",
  });
  await database.insert(schema.clients).values({
    id: clientId,
    userId: ownerId,
    name: "secret client",
    email: "secret@secret.test",
  });
  const invoice = (await createDraftInvoice(database, ownerId, {
    clientId,
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
    notes: "secret notes",
    items: [{ description: "secret work", quantity: 1, rate: 10 }],
  }))!;
  return { ownerId, clientId, invoice };
}
async function history(ownerId: string) {
  return database
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.ownerId, ownerId));
}

test("account, client, invoice, and manual status changes record only approved fields", async () => {
  const { ownerId, invoice } = await fixture();
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, invoice.id));
  await changeInvoiceStatus(database, ownerId, invoice.id, "paid");
  const events = await history(ownerId);
  expect(events.map((e) => e.action)).toEqual(
    expect.arrayContaining([
      "account.created",
      "client.created",
      "invoice.created",
      "invoice.items_changed",
      "invoice.status_changed",
    ]),
  );
  expect(
    events
      .filter((e) => e.action === "invoice.status_changed")
      .map((e) => e.details),
  ).toEqual([
    { from: "draft", to: "sent" },
    { from: "sent", to: "paid" },
  ]);
  expect(JSON.stringify(events)).not.toContain("secret");
});

test("concurrent payment replays produce one financial audit event", async () => {
  const { ownerId, invoice } = await fixture();
  await database
    .update(schema.invoices)
    .set({ status: "sent" })
    .where(eq(schema.invoices.id, invoice.id));
  const charge = {
    reference: `secret-${randomUUID()}`,
    amount: 1000,
    currency: "NGN",
    status: "success" as const,
    paid_at: "2026-01-02T00:00:00.000Z",
    metadata: { invoice_id: invoice.id },
  };
  await Promise.all([
    recordPaystackPayment(database, charge),
    recordPaystackPayment(database, charge),
  ]);
  const payments = (await history(ownerId)).filter(
    (e) => e.action === "payment.recorded",
  );
  expect(payments).toHaveLength(1);
  expect(payments[0].details).toEqual({
    invoiceId: invoice.id,
    amountPaid: "10.00",
  });
  expect(JSON.stringify(payments)).not.toContain("secret");
});

test("rolled-back mutations leave no audit history", async () => {
  const { ownerId } = await fixture();
  const before = await history(ownerId);
  await expect(
    database.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ passwordHash: "new-secret" })
        .where(eq(schema.users.id, ownerId));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(await history(ownerId)).toHaveLength(before.length);
});

test("session rotation, verification, password, and email events exclude credentials and content", async () => {
  const { ownerId } = await fixture();
  const sessionId = randomUUID(),
    tokenId = randomUUID(),
    jobId = randomUUID();
  await database.insert(schema.refreshTokens).values({
    id: tokenId,
    userId: ownerId,
    sessionId,
    tokenHash: "secret-token-hash",
    expiresAt: new Date(Date.now() + 60000),
  });
  await database.transaction(async (tx) => {
    await tx
      .update(schema.refreshTokens)
      .set({ revoked: true })
      .where(eq(schema.refreshTokens.id, tokenId));
    await tx.insert(schema.refreshTokens).values({
      id: randomUUID(),
      userId: ownerId,
      sessionId,
      tokenHash: "secret-replacement-hash",
      expiresAt: new Date(Date.now() + 60000),
    });
  });
  await database
    .update(schema.users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(schema.users.id, ownerId));
  await database
    .update(schema.users)
    .set({ passwordHash: "secret-new-password" })
    .where(eq(schema.users.id, ownerId));
  await database.insert(schema.emailJobs).values({
    id: jobId,
    userId: ownerId,
    purpose: "verification",
    tokenHash: "secret-hash",
    payload: "secret-encrypted-content",
    expiresAt: new Date(Date.now() + 60000),
  });
  await database
    .update(schema.emailJobs)
    .set({
      status: "accepted",
      payload: null,
      providerMessageId: "secret-provider-id",
    })
    .where(eq(schema.emailJobs.id, jobId));
  const events = await history(ownerId);
  expect(events.filter((e) => e.action === "session.created")).toHaveLength(1);
  expect(events.map((e) => e.action)).toEqual(
    expect.arrayContaining([
      "session.revoked",
      "account.verification_changed",
      "account.password_changed",
      "email.queued",
      "email.accepted",
    ]),
  );
  expect(JSON.stringify(events)).not.toContain("secret");
});

test("Trash transitions and draft deletion retain history without logging no-op writes", async () => {
  const { ownerId, invoice } = await fixture();
  const before = await history(ownerId);
  await database
    .update(schema.invoices)
    .set({ updatedAt: new Date() })
    .where(eq(schema.invoices.id, invoice.id));
  expect(await history(ownerId)).toHaveLength(before.length);
  await database
    .update(schema.invoices)
    .set({ deletedAt: new Date() })
    .where(eq(schema.invoices.id, invoice.id));
  await database
    .update(schema.invoices)
    .set({ deletedAt: null })
    .where(eq(schema.invoices.id, invoice.id));
  await database
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, invoice.id));
  const actions = (await history(ownerId)).map((e) => e.action);
  expect(actions).toEqual(
    expect.arrayContaining([
      "invoice.archived",
      "invoice.restored",
      "invoice.deleted",
    ]),
  );
});

test("audit insertion failure rolls back the business mutation", async () => {
  const { ownerId } = await fixture();
  await client.unsafe(
    `CREATE FUNCTION reject_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$; CREATE TRIGGER reject_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_test();`,
  );
  try {
    await expect(
      database
        .update(schema.users)
        .set({ fullName: "changed" })
        .where(eq(schema.users.id, ownerId))
        .execute(),
    ).rejects.toThrow("injected audit failure");
    expect(
      (
        await database.query.users.findFirst({
          where: eq(schema.users.id, ownerId),
        })
      )?.fullName,
    ).toBe("secret owner");
  } finally {
    await client.unsafe(
      "DROP TRIGGER reject_audit_test ON audit_events; DROP FUNCTION reject_audit_test()",
    );
  }
});

test("history survives account deletion and rejects update, delete, and truncate", async () => {
  const id = randomUUID();
  await database
    .insert(schema.users)
    .values({ id, email: `${id}@example.test`, fullName: "Owner" });
  await database.delete(schema.users).where(eq(schema.users.id, id));
  expect((await history(id)).map((e) => e.action)).toEqual([
    "account.created",
    "account.deleted",
  ]);
  for (const query of [
    "UPDATE audit_events SET action = 'changed'",
    "DELETE FROM audit_events",
    "TRUNCATE audit_events",
  ]) {
    await expect(client.unsafe(query)).rejects.toThrow(
      "Audit events cannot be changed or removed",
    );
  }
});
