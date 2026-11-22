import "../src/instrumentation";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { db, closeDatabase } from "../src/db";
import { reportError } from "../src/lib/observability";
import { flushMonitoring } from "../src/instrumentation";

try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
  });
  await import("../src/index");
} catch (error) {
  reportError("api.start_failed", error);
  await closeDatabase().catch(() => {});
  await flushMonitoring().catch(() => {});
  process.exit(1);
}
