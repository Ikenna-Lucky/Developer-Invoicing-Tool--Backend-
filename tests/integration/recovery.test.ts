import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import * as schema from "../../src/db/schema";
import { createDraftInvoice } from "../../src/lib/invoices";
import { recordPaystackPayment } from "../../src/lib/payments";
import { enqueueEmail, decryptEmail } from "../../src/lib/email-queue";
import {
  backupDatabase,
  restoreDatabase,
  runPostgresTool,
  type ToolRunner,
} from "../../scripts/lib/database-backup";

const context = createTestDatabase();
const sourceUrl = new URL(process.env.TEST_DATABASE_URL!);
const targetName = `billd_restore_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(sourceUrl.toString(), { max: 1 });
const targetUrl = new URL(sourceUrl);
targetUrl.pathname = `/${targetName}`;
const targetClient = postgres(targetUrl.toString(), { max: 1 });
const restored = drizzle(targetClient, { schema });
const key = "a".repeat(64);
let directory: string, file: string, source: string;
let userId: string, clientId: string, invoiceId: string, jobId: string;
let before: Record<string, unknown[]>;

// Windows development uses the same PostgreSQL utilities inside the test server.
// CI invokes the installed utilities directly, exercising the production runner.
const runTool: ToolRunner = process.env.RECOVERY_TEST_CONTAINER
  ? async (tool, args, env, input, output) => {
      const dockerArgs = [
        "exec",
        "-i",
        ...Object.keys(env).flatMap((key) => ["-e", key]),
        process.env.RECOVERY_TEST_CONTAINER!,
        tool,
        ...args,
      ];
      await runPostgresTool(
        "docker",
        dockerArgs,
        { ...env, PGHOST: "127.0.0.1", PGPORT: "5432" },
        input,
        output,
      );
    }
  : runPostgresTool;

async function records(client: ReturnType<typeof postgres>) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "users",
    "clients",
    "invoices",
    "invoice_items",
    "payments",
    "audit_events",
    "email_jobs",
    "invoice_counters",
  ])
    result[table] = await client.unsafe(
      `SELECT * FROM ${table} ORDER BY ${table === "invoice_counters" ? "user_id" : "id"}`,
    );
  result.migrations = await client.unsafe(
    "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  return result;
}

beforeAll(async () => {
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY = "b".repeat(64);
  await context.create();
  await migrate(context.database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  const name = await context.client`SELECT current_database() AS name`;
  const url = new URL(sourceUrl);
  url.pathname = `/${name[0].name}`;
  url.searchParams.set("sslmode", "disable");
  source = url.toString();
  targetUrl.searchParams.set("sslmode", "disable");
  await admin.unsafe(`CREATE DATABASE "${targetName}"`);
  directory = await mkdtemp(join(tmpdir(), "billd-recovery-test-"));
  file = join(directory, "test.billd-backup");
  userId = randomUUID();
  clientId = randomUUID();
  await context.database.insert(schema.users).values({
    id: userId,
    email: "recovery@example.test",
    fullName: "Recovery Owner",
    emailVerifiedAt: new Date(),
  });
  await context.database.insert(schema.clients).values({
    id: clientId,
    userId,
    name: "Recovery Client",
    email: "client@example.test",
  });
  const invoice = (await createDraftInvoice(context.database, userId, {
    clientId,
    issueDate: "2026-11-01",
    dueDate: "2026-11-30",
    items: [{ description: "Recovery work", quantity: 1, rate: 1250.5 }],
  }))!;
  invoiceId = invoice.id;
  await context.database
    .update(schema.invoices)
    .set({ status: "sent", paystackRoutingRequired: false })
    .where(eq(schema.invoices.id, invoiceId));
  await recordPaystackPayment(context.database, {
    reference: `recovery-${randomUUID()}`,
    status: "success",
    amount: 125050,
    currency: "NGN",
    paid_at: "2026-11-21T10:00:00Z",
    metadata: { invoice_id: invoiceId },
  });
  jobId = (
    await enqueueEmail(context.database, {
      userId,
      invoiceId,
      purpose: "invoice",
      message: {
        to: "client@example.test",
        subject: "Recovery test",
        html: "Test recovery content",
      },
    })
  ).id;
  before = await records(context.client);
}, 30_000);

afterAll(async () => {
  await targetClient.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${targetName}"`);
  await admin.end();
  await context.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("an encrypted backup restores exact financial, audit, queue, and migration records", async () => {
  const saved = await backupDatabase({
    databaseUrl: source,
    key,
    file,
    runTool,
  });
  expect(saved.bytes).toBeGreaterThan(36);
  expect((await readFile(file)).includes(Buffer.from("Recovery Owner"))).toBe(
    false,
  );
  const result = await restoreDatabase({
    databaseUrl: targetUrl.toString(),
    key,
    file,
    confirmedDatabase: targetName,
    runTool,
  });
  expect(await records(targetClient)).toEqual(before);
  const job = await restored.query.emailJobs.findFirst({
    where: eq(schema.emailJobs.id, jobId),
  });
  expect(decryptEmail(job!.id, job!.payload!).subject).toBe("Recovery test");
  console.log(
    JSON.stringify({
      event: "recovery.drill_passed",
      durationMs: result.durationMs,
      backupBytes: saved.bytes,
    }),
  );
}, 30_000);

test("restored audit/financial protections, counters, and payment replay behavior still work", async () => {
  await expect(targetClient`DELETE FROM audit_events`).rejects.toThrow(
    "Audit events cannot be changed or removed",
  );
  await expect(
    targetClient`UPDATE invoices SET total_amount = 1 WHERE id = ${invoiceId}`,
  ).rejects.toThrow();
  const draft = await createDraftInvoice(restored, userId, {
    clientId,
    issueDate: "2026-11-01",
    dueDate: "2026-11-30",
    items: [{ description: "Next work", quantity: 1, rate: 10 }],
  });
  expect(draft!.invoiceNumber).toBe("INV-0002");
  const payment = await restored.query.payments.findFirst({
    where: eq(schema.payments.invoiceId, invoiceId),
  });
  expect(
    await recordPaystackPayment(restored, {
      reference: payment!.stripePaymentId!,
      status: "success",
      amount: 125050,
      currency: "NGN",
      paid_at: "2026-11-21T10:00:00Z",
      metadata: { invoice_id: invoiceId },
    }),
  ).toBe("duplicate");
});

test("wrong keys and corrupted archives fail before PostgreSQL is invoked", async () => {
  let called = false;
  const forbidden: ToolRunner = async () => {
    called = true;
    throw new Error("must not run");
  };
  await expect(
    restoreDatabase({
      databaseUrl: targetUrl.toString(),
      key: "c".repeat(64),
      file,
      confirmedDatabase: targetName,
      runTool: forbidden,
    }),
  ).rejects.toThrow("authentication failed");
  const corrupt = join(directory, "corrupt.billd-backup");
  const bytes = await readFile(file);
  bytes[30] ^= 1;
  await writeFile(corrupt, bytes);
  await expect(
    restoreDatabase({
      databaseUrl: targetUrl.toString(),
      key,
      file: corrupt,
      confirmedDatabase: targetName,
      runTool: forbidden,
    }),
  ).rejects.toThrow("authentication failed");
  expect(called).toBe(false);
});

test("restore refuses populated databases and backup refuses existing files", async () => {
  const recordsBefore = await records(targetClient);
  await expect(
    restoreDatabase({
      databaseUrl: targetUrl.toString(),
      key,
      file,
      confirmedDatabase: targetName,
      runTool,
    }),
  ).rejects.toThrow("must be empty");
  const bytes = await readFile(file);
  await expect(
    backupDatabase({ databaseUrl: source, key, file, runTool }),
  ).rejects.toThrow();
  expect(await readFile(file)).toEqual(bytes);
  expect(await records(targetClient)).toEqual(recordsBefore);
});
