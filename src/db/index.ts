import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

// Create a Postgres client
const client = postgres(connectionString, { ssl: "require" });

// Create the Drizzle ORM instance with our schema
export const db = drizzle(client, { schema });

export type DB = typeof db;
