import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import { users, refreshTokens, passwordResetTokens } from "../../src/db/schema";

const context = createTestDatabase();
const { client, database } = context;
const folder = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const userId = randomUUID(),
  oldSessionId = randomUUID(),
  latestResetId = randomUUID();

beforeAll(async () => {
  await context.create();
  const previous = readMigrationFiles({ migrationsFolder: folder }).slice(0, 5);
  for (const migration of previous)
    for (const statement of migration.sql) await client.unsafe(statement);
  const last = previous[previous.length - 1];
  await client.unsafe(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await client`insert into drizzle.__drizzle_migrations (hash, created_at) values (${last.hash}, ${last.folderMillis})`;
  await client`insert into users (id, email, password_hash, full_name) values (${userId}, 'legacy-session@example.test', 'test-hash', 'Legacy User')`;
  await client`insert into refresh_tokens (id, user_id, token_hash, expires_at) values (${oldSessionId}, ${userId}, 'legacy-refresh-hash', '2099-01-01')`;
  await client`insert into password_reset_tokens (id, user_id, token_hash, expires_at, created_at) values
    (${randomUUID()}, ${userId}, 'older-reset-hash', '2099-01-01', '2026-01-01'),
    (${latestResetId}, ${userId}, 'newest-reset-hash', '2099-01-01', '2026-01-02')`;
  await migrate(database, { migrationsFolder: folder });
}, 30_000);
afterAll(async () => {
  await context.close();
});

test("session migration backfills existing rows without losing their hashes", async () => {
  const token = await database.query.refreshTokens.findFirst({
    where: eq(refreshTokens.id, oldSessionId),
  });
  expect(token?.sessionId).toBe(oldSessionId);
  expect(token?.tokenHash).toBe("legacy-refresh-hash");
  expect(
    (await database.query.users.findFirst({ where: eq(users.id, userId) }))
      ?.sessionVersion,
  ).toBe(0);
});

test("migration retains the latest reset token and enforces one token per account", async () => {
  const tokens = await database.query.passwordResetTokens.findMany({
    where: eq(passwordResetTokens.userId, userId),
  });
  expect(tokens).toHaveLength(1);
  expect(tokens[0].id).toBe(latestResetId);
  await expect(
    database
      .insert(passwordResetTokens)
      .values({
        id: randomUUID(),
        userId,
        tokenHash: "additional-reset-hash",
        expiresAt: new Date("2099-01-01"),
      })
      .execute(),
  ).rejects.toThrow("password_reset_tokens_user_id_unique");
});

test("only one active refresh token can exist per session while revoked history is retained", async () => {
  const ownerId = randomUUID(),
    sessionId = randomUUID();
  await database.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    fullName: "Test User",
  });
  const originalId = randomUUID();
  await database.insert(refreshTokens).values({
    id: originalId,
    userId: ownerId,
    sessionId,
    tokenHash: randomUUID(),
    expiresAt: new Date("2099-01-01"),
  });
  await expect(
    database
      .insert(refreshTokens)
      .values({
        id: randomUUID(),
        userId: ownerId,
        sessionId,
        tokenHash: randomUUID(),
        expiresAt: new Date("2099-01-01"),
      })
      .execute(),
  ).rejects.toThrow("refresh_tokens_active_session_unique");
  await database
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.id, originalId));
  await database.insert(refreshTokens).values({
    id: randomUUID(),
    userId: ownerId,
    sessionId,
    tokenHash: randomUUID(),
    expiresAt: new Date("2099-01-01"),
  });
  expect(
    await database.query.refreshTokens.findMany({
      where: eq(refreshTokens.sessionId, sessionId),
    }),
  ).toHaveLength(2);
});
