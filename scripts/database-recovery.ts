import { backupDatabase, restoreDatabase } from "./lib/database-backup";

const [operation, file] = process.argv.slice(2);
try {
  if (
    !["backup", "restore"].includes(operation) ||
    !file ||
    process.argv.length !== 4
  )
    throw new Error(
      "Usage: bun run scripts/database-recovery.ts <backup|restore> <encrypted-file>",
    );
  const key = process.env.BACKUP_ENCRYPTION_KEY ?? "";
  if (key && key === process.env.EMAIL_QUEUE_ENCRYPTION_KEY)
    throw new Error("Use a separate encryption key for database backups");
  if (operation === "backup") {
    const result = await backupDatabase({
      databaseUrl: process.env.BACKUP_DATABASE_URL ?? "",
      key,
      file,
    });
    console.log(
      JSON.stringify({
        event: "backup.completed",
        bytes: result.bytes,
        completedAt: new Date().toISOString(),
      }),
    );
  } else {
    const result = await restoreDatabase({
      databaseUrl: process.env.RESTORE_DATABASE_URL ?? "",
      confirmedDatabase: process.env.RESTORE_CONFIRM_DATABASE ?? "",
      key,
      file,
    });
    console.log(
      JSON.stringify({
        event: "restore.completed",
        durationMs: result.durationMs,
        requiresApplicationVerification: true,
      }),
    );
  }
} catch {
  console.error(
    "Database recovery command failed. Check the operation, file, separate backup key, PostgreSQL tools, direct connection, and empty recovery target. No successful backup or recovery is recorded.",
  );
  process.exitCode = 1;
}
