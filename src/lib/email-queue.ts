import { reportError } from "./observability";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import {
  emailJobs,
  emailVerificationTokens,
  passwordResetTokens,
} from "../db/schema";
import { deliverMail, type MailMessage } from "./email";

type Writer = Pick<DB, "insert" | "update">;

export function emailQueueKey(
  key = process.env.EMAIL_QUEUE_ENCRYPTION_KEY ?? "",
) {
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new Error(
      "EMAIL_QUEUE_ENCRYPTION_KEY must be 64 hexadecimal characters",
    );
  return Buffer.from(key, "hex");
}

export function encryptEmail(id: string, message: MailMessage) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", emailQueueKey(), iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptEmail(id: string, value: string): MailMessage {
  const buffer = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    emailQueueKey(),
    buffer.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export async function enqueueEmail(
  writer: Writer,
  options: {
    userId: string;
    invoiceId?: string;
    purpose: typeof emailJobs.$inferInsert.purpose;
    tokenHash?: string;
    expiresAt?: Date;
    message: Omit<MailMessage, "from">;
  },
) {
  const id = randomUUID();
  const payload = encryptEmail(id, {
    ...options.message,
    from: process.env.EMAIL_FROM ?? "Billd <onboarding@resend.dev>",
  });
  await writer.insert(emailJobs).values({
    id,
    userId: options.userId,
    invoiceId: options.invoiceId,
    purpose: options.purpose,
    tokenHash: options.tokenHash,
    payload,
    // Resend retains idempotency keys for 24 hours. Never retry a job beyond 23 hours.
    expiresAt: new Date(
      Math.min(
        options.expiresAt?.getTime() ?? Infinity,
        Date.now() + 23 * 3600_000,
      ),
    ),
  });
  return { id, status: "pending" as const };
}

export async function cancelTokenEmails(
  writer: Writer,
  userId: string,
  purpose: "verification" | "password_reset",
) {
  await writer
    .update(emailJobs)
    .set({
      status: "cancelled",
      payload: null,
      claimId: null,
      lockedUntil: null,
    })
    .where(
      and(
        eq(emailJobs.userId, userId),
        eq(emailJobs.purpose, purpose),
        inArray(emailJobs.status, ["pending", "processing"]),
      ),
    );
}

export async function processNextEmail(
  database: DB,
  send = deliverMail,
): Promise<boolean> {
  const expired =
    await database.execute(sql`UPDATE email_jobs SET status = 'failed', payload = NULL,
    last_error = 'expired', claim_id = NULL, locked_until = NULL
    WHERE id IN (SELECT id FROM email_jobs WHERE status IN ('pending', 'processing') AND
      (expires_at <= now() OR (attempts >= 6 AND status = 'processing' AND locked_until <= now())) LIMIT 100)
    AND status IN ('pending', 'processing') AND
      (expires_at <= now() OR (attempts >= 6 AND status = 'processing' AND locked_until <= now())) RETURNING id`);
  if (expired.length) reportError("email.delivery_failed");
  const claimId = randomUUID();
  const rows = await database.execute(sql`
    WITH candidate AS (
      SELECT id FROM email_jobs WHERE expires_at > now() AND attempts < 6 AND
        ((status = 'pending' AND next_attempt_at <= now()) OR
         (status = 'processing' AND locked_until <= now()))
      ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE email_jobs SET status = 'processing', claim_id = ${claimId},
      locked_until = now() + interval '2 minutes', attempts = attempts + 1
    FROM candidate WHERE email_jobs.id = candidate.id RETURNING email_jobs.id
  `);
  if (!rows.length) return false;
  const id = String(rows[0].id);
  const job = (await database.query.emailJobs.findFirst({
    where: eq(emailJobs.id, id),
  }))!;
  const ownedClaim = and(
    eq(emailJobs.id, id),
    eq(emailJobs.claimId, claimId),
    eq(emailJobs.status, "processing"),
  );
  if (!job || job.claimId !== claimId || job.status !== "processing")
    return true;
  if (job.tokenHash) {
    const table =
      job.purpose === "verification"
        ? emailVerificationTokens
        : passwordResetTokens;
    const [token] = await database
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tokenHash, job.tokenHash),
          eq(table.userId, job.userId),
          gt(table.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!token) {
      await database
        .update(emailJobs)
        .set({
          status: "cancelled",
          payload: null,
          claimId: null,
          lockedUntil: null,
        })
        .where(ownedClaim);
      return true;
    }
  }
  let result: Awaited<ReturnType<typeof deliverMail>>;
  let message: MailMessage;
  try {
    message = decryptEmail(id, job.payload!);
  } catch {
    await database
      .update(emailJobs)
      .set({
        status: "failed",
        payload: null,
        lastError: "invalid_payload",
        claimId: null,
        lockedUntil: null,
      })
      .where(ownedClaim);
    reportError("email.delivery_failed");
    return true;
  }
  try {
    result = await send(message, `billd-email/${id}`);
  } catch {
    result = { accepted: false, retryable: true, code: "network_error" };
  }
  if (result.accepted) {
    await database
      .update(emailJobs)
      .set({
        status: "accepted",
        providerMessageId: result.id,
        acceptedAt: new Date(),
        payload: null,
        lastError: null,
        claimId: null,
        lockedUntil: null,
      })
      .where(ownedClaim);
  } else {
    const retry =
      result.retryable &&
      job.attempts < 6 &&
      job.expiresAt.getTime() > Date.now();
    const updated = await database
      .update(emailJobs)
      .set({
        status: retry ? "pending" : "failed",
        payload: retry ? job.payload : null,
        nextAttemptAt: new Date(
          Date.now() +
            30_000 * 2 ** (job.attempts - 1) +
            Math.floor(Math.random() * 5000),
        ),
        lastError: result.code,
        claimId: null,
        lockedUntil: null,
      })
      .where(ownedClaim)
      .returning({ id: emailJobs.id });
    if (!retry && updated.length) reportError("email.delivery_failed");
  }
  return true;
}

export function startEmailWorker(
  database: DB,
  processJob = processNextEmail,
  intervalMs = 2000,
) {
  let stopped = false;
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = Promise.resolve()
      .then(async () => {
        if (!stopped) await processJob(database);
      })
      .catch((error) => {
        reportError("email.worker_failed", error);
      })
      .finally(() => {
        running = undefined;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
