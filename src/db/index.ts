import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

/**
 * postgres.js client tuned for Neon's PgBouncer pooler endpoint.
 *
 * Key settings:
 *  - prepare: false  — PgBouncer in transaction mode does NOT support
 *                      prepared statements; without this flag every query
 *                      causes a protocol error or silent fall-back overhead.
 *  - max: 10         — pool ceiling; matches Neon free-tier connection limit.
 *  - idle_timeout: 20 — return idle connections to the pool quickly so Neon
 *                       can release server-side resources.
 *  - connect_timeout: 10 — fail fast instead of hanging for 30 s+.
 */
const client = postgres(connectionString, {
  ssl:             "require",
  prepare:         false,   // required for PgBouncer compatibility
  max:             10,
  idle_timeout:    20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

export type DB = typeof db;
