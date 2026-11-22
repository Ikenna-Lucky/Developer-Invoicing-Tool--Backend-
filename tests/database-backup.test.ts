import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupDatabase,
  restoreDatabase,
  connectionEnvironment,
  type ToolRunner,
} from "../scripts/lib/database-backup";

const local =
  "postgresql://ci:secret@127.0.0.1:5432/billd_restore_test?sslmode=disable";
test("Neon pooling, insecure remote connections, and unexpected connection options are rejected", () => {
  for (const value of [
    "invalid",
    "https://host/db",
    "postgresql://ci:secret@ep-test-pooler.neon.tech/db",
    "postgresql://ci:secret@remote/db?sslmode=disable",
    "postgresql://ci:secret@remote/db?options=secret",
  ])
    expect(() => connectionEnvironment(value)).toThrow();
  const env = connectionEnvironment(
    "postgresql://ci:p%40ss@ep-test.neon.tech/neondb?sslmode=require&channel_binding=require",
  );
  expect(env.PGPASSWORD).toBe("p@ss");
  expect(env.PGSSLMODE).toBe("require");
});

test("restore requires the dedicated name and matching confirmation before invoking tools", async () => {
  let called = false;
  const runTool: ToolRunner = async () => {
    called = true;
  };
  for (const [databaseUrl, confirmedDatabase] of [
    [local, "wrong"],
    [local.replace("billd_restore_test", "production"), "production"],
  ])
    await expect(
      restoreDatabase({
        databaseUrl,
        confirmedDatabase,
        key: "a".repeat(64),
        file: "unused",
        runTool,
      }),
    ).rejects.toThrow("Restore requires");
  expect(called).toBe(false);
});

test("a failed dump removes partial output and does not report success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "billd-failed-backup-"));
  try {
    const runTool: ToolRunner = async (_tool, _args, _env, _input, output) => {
      output.write("partial dump");
      throw new Error("secret provider detail");
    };
    await expect(
      backupDatabase({
        databaseUrl: local,
        key: "a".repeat(64),
        file: join(directory, "partial.billd-backup"),
        runTool,
      }),
    ).rejects.toThrow("Database backup failed");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
