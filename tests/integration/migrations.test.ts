import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import { createDraftInvoice } from "../../src/lib/invoices";
import * as schema from "../../src/db/schema";

const context = createTestDatabase();
const { client, database } = context;
const folder = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const userId = randomUUID(),
  clientId = randomUUID(),
  invoiceId = randomUUID();

beforeAll(async () => {
  await context.create();
  const initial = await readFile(
    new URL("../../drizzle/0000_keen_squirrel_girl.sql", import.meta.url),
    "utf8",
  );
  for (const statement of initial.split("--> statement-breakpoint"))
    await client.unsafe(statement);
  const migration = readMigrationFiles({ migrationsFolder: folder })[0];
  // Reproduce a database where the initial journal timestamp caused later entries to be skipped.
  await client.unsafe(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await client`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`;
  await client`insert into users (id, email, password_hash, full_name) values (${userId}, 'legacy@example.test', 'test-hash', 'Legacy Owner')`;
  await client`insert into clients (id, user_id, name, email) values (${clientId}, ${userId}, 'Legacy Client', 'client@example.test')`;
  await client`insert into invoices (id, user_id, client_id, invoice_number, status, issue_date, due_date, total_amount)
    values (${invoiceId}, ${userId}, ${clientId}, 'INV-0042', 'sent', '2026-01-01', '2026-01-31', 100)`;
  await migrate(database, { migrationsFolder: folder });
}, 30_000);
afterAll(async () => {
  await context.close();
});

test("forward migration repairs skipped auth and Trash fields without losing invoices", async () => {
  const invoice = await database.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId),
  });
  expect(invoice?.invoiceNumber).toBe("INV-0042");
  expect(invoice?.status).toBe("sent");
  expect(invoice?.deletedAt).toBe(null);
  await database
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email: "google@example.test",
      fullName: "Google User",
      googleId: "test-google-id",
    });
  expect(await database.query.passwordResetTokens.findMany()).toHaveLength(0);
});

test("backfilled counters continue the owner's existing numbering", async () => {
  const invoice = await createDraftInvoice(database, userId, {
    clientId,
    issueDate: "2026-01-01T00:00:00.000Z",
    dueDate: "2026-01-31T00:00:00.000Z",
    items: [{ description: "New work", quantity: 1, rate: 10 }],
  });
  expect(invoice?.invoiceNumber).toBe("INV-0043");
});

test("rerunning the migrator is a no-op and does not reset counters", async () => {
  const counterBefore = await database.query.invoiceCounters.findFirst({
    where: eq(schema.invoiceCounters.userId, userId),
  });
  const before =
    await client`select * from drizzle.__drizzle_migrations order by id`;
  await migrate(database, { migrationsFolder: folder });
  const after =
    await client`select * from drizzle.__drizzle_migrations order by id`;
  expect(after.length).toBe(before.length);
  expect(
    (
      await database.query.invoiceCounters.findFirst({
        where: eq(schema.invoiceCounters.userId, userId),
      })
    )?.lastNumber,
  ).toBe(counterBefore?.lastNumber);
});
