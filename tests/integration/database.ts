import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema";

export function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  const url = new URL(connectionString);
  if (
    url.pathname !== "/billd_test" ||
    !["localhost", "127.0.0.1", "billd-review-postgres"].includes(url.hostname)
  ) {
    throw new Error("Tests require a local, disposable billd_test database");
  }
  const name = `billd_test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(connectionString, { max: 1 });
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 5 });
  return {
    client,
    database: drizzle(client, { schema }),
    async create() {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    },
    async close() {
      try {
        await client.end();
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
