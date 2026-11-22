import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

const magic = Buffer.from("BILLDBK1");
const headerBytes = magic.length + 12;
export type ToolRunner = (
  tool: string,
  args: string[],
  env: Record<string, string>,
  input: Readable | undefined,
  output: Writable,
) => Promise<void>;

export const runPostgresTool: ToolRunner = async (
  tool,
  args,
  env,
  input,
  output,
) => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "TMP",
        "TEMP",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
      ].includes(key.toUpperCase()),
    ),
  );
  const child = spawn(tool, args, {
    env: { ...inherited, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // PostgreSQL diagnostics can include connection details and restored row data.
  child.stderr.resume();
  const exited = new Promise<void>((accept, reject) => {
    child.once("error", () =>
      reject(
        new Error(
          `${tool} could not start; check the PostgreSQL client installation`,
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `${tool} failed; check permissions, connectivity, archive, and PostgreSQL versions`,
            ),
          ),
    );
  });
  const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
  const writing = input
    ? pipeline(input, child.stdin)
    : Promise.resolve(child.stdin.end()).then(() => {});
  const reading = pipeline(child.stdout, output);
  try {
    await Promise.all([writing, reading, exited]);
  } catch {
    child.kill();
    input?.destroy();
    output.destroy();
    await Promise.allSettled([writing, reading, exited]);
    throw new Error(`${tool} failed; no successful recovery is recorded`);
  } finally {
    clearTimeout(timer);
  }
};

export function connectionEnvironment(
  connectionString: string,
): Record<string, string> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Supply a valid PostgreSQL connection URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname.slice(1) ||
    url.hash
  )
    throw new Error("Supply a PostgreSQL URL with host, user, and database");
  if (url.hostname.includes("-pooler."))
    throw new Error("Use Neon's direct connection URL with pooling disabled");
  for (const key of url.searchParams.keys()) {
    if (!["sslmode", "channel_binding"].includes(key))
      throw new Error(
        "Backup URLs only support sslmode and channel_binding parameters",
      );
  }
  const sslmode = url.searchParams.get("sslmode") ?? "require";
  if (
    ![
      "disable",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
    ].includes(sslmode)
  )
    throw new Error("Invalid backup sslmode");
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
    !["require", "verify-ca", "verify-full"].includes(sslmode)
  )
    throw new Error("Remote backups require TLS");
  const binding = url.searchParams.get("channel_binding") ?? "prefer";
  if (!["disable", "prefer", "require"].includes(binding))
    throw new Error("Invalid channel_binding");
  try {
    return {
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: sslmode,
      PGCHANNELBINDING: binding,
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "billd-recovery",
    };
  } catch {
    throw new Error("Invalid encoding in PostgreSQL URL");
  }
}

function encryptionKey(key: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new Error(
      "BACKUP_ENCRYPTION_KEY must be a separate 32-byte hexadecimal key",
    );
  return Buffer.from(key, "hex");
}

type BackupOptions = {
  databaseUrl: string;
  key: string;
  file: string;
  runTool?: ToolRunner;
};

export async function backupDatabase({
  databaseUrl,
  key,
  file,
  runTool = runPostgresTool,
}: BackupOptions) {
  const env = connectionEnvironment(databaseUrl);
  const secret = encryptionKey(key);
  const iv = randomBytes(12);
  const header = Buffer.concat([magic, iv]);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(header);
  const target = resolve(file);
  const sink = createWriteStream(target, { flags: "wx", mode: 0o600 });
  await once(sink, "open");
  try {
    sink.write(header);
    const encrypting = pipeline(cipher, sink);
    // Start both ends together so a large archive cannot fill an unread pipe.
    const dumping = runTool(
      "pg_dump",
      ["--format=custom", "--no-password", "--lock-wait-timeout=30s"],
      env,
      undefined,
      cipher,
    );
    try {
      await Promise.all([dumping, encrypting]);
    } catch {
      cipher.destroy();
      sink.destroy();
      await Promise.allSettled([dumping, encrypting]);
      throw new Error("Database backup failed");
    }
    await appendFile(target, cipher.getAuthTag());
    const completed = await open(target, "r+");
    try {
      await completed.sync();
    } finally {
      await completed.close();
    }
  } catch (error) {
    sink.destroy();
    await rm(target, { force: true });
    throw error;
  }
  return { bytes: (await stat(target)).size };
}

async function query(
  runTool: ToolRunner,
  env: Record<string, string>,
  sql: string,
) {
  let result = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      result += chunk.toString();
      done();
    },
  });
  await runTool(
    "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ],
    env,
    undefined,
    output,
  );
  return result.trim();
}

export async function restoreDatabase({
  databaseUrl,
  key,
  file,
  confirmedDatabase,
  runTool = runPostgresTool,
}: BackupOptions & { confirmedDatabase: string }) {
  const env = connectionEnvironment(databaseUrl);
  if (
    !/^billd_restore_[a-z0-9_]+$/.test(env.PGDATABASE) ||
    confirmedDatabase !== env.PGDATABASE
  )
    throw new Error(
      "Restore requires a database named billd_restore_<name> and matching RESTORE_CONFIRM_DATABASE",
    );
  const secret = encryptionKey(key);
  const source = resolve(file);
  const size = (await stat(source)).size;
  if (size <= headerBytes + 16) throw new Error("Invalid encrypted backup");
  const archive = await open(source, "r");
  const header = Buffer.alloc(headerBytes),
    tag = Buffer.alloc(16);
  try {
    await archive.read(header, 0, header.length, 0);
    await archive.read(tag, 0, 16, size - 16);
  } finally {
    await archive.close();
  }
  if (!header.subarray(0, magic.length).equals(magic))
    throw new Error("Unsupported backup format");
  const directory = await mkdtemp(join(tmpdir(), "billd-restore-"));
  const dump = join(directory, "database.dump");
  const started = performance.now();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      header.subarray(magic.length),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    // Authenticate the entire archive before pg_restore can execute any SQL.
    try {
      await pipeline(
        createReadStream(source, { start: headerBytes, end: size - 17 }),
        decipher,
        createWriteStream(dump, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      throw new Error(
        "Backup authentication failed; check the key and file integrity",
      );
    }
    const occupied = await query(
      runTool,
      env,
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'",
    );
    if (occupied !== "0")
      throw new Error(
        "Restore target must be empty; existing data will not be overwritten",
      );
    await runTool(
      "pg_restore",
      [
        "--no-password",
        "--dbname",
        env.PGDATABASE,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
      ],
      env,
      createReadStream(dump),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    const valid = await query(
      runTool,
      env,
      "SELECT count(*) FROM information_schema.tables WHERE (table_schema = 'public' AND table_name IN ('users', 'clients', 'invoices', 'invoice_items', 'payments', 'audit_events', 'invoice_counters', 'refresh_tokens', 'password_reset_tokens', 'email_verification_tokens', 'email_jobs', 'request_rate_limits')) OR (table_schema = 'drizzle' AND table_name = '__drizzle_migrations')",
    );
    if (valid !== "13")
      throw new Error(
        "Restore completed but required Billd tables are missing; do not cut over",
      );
    return { durationMs: Math.round(performance.now() - started) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
