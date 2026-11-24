import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import {
  users,
  emailJobs,
  emailVerificationTokens,
  passwordResetTokens,
} from "../../src/db/schema";
import {
  registerWithPassword,
  requestPasswordReset,
} from "../../src/lib/sessions";
import {
  resendVerification,
  verifyEmail,
} from "../../src/lib/email-verification";
import {
  encryptEmail,
  decryptEmail,
  enqueueEmail,
  processNextEmail,
  startEmailWorker,
} from "../../src/lib/email-queue";
import type { DB } from "../../src/db";

const context = createTestDatabase();
const { database, client } = context;
const password = "Email test password 123";
let auth: ReturnType<typeof import("../../src/routes/auth").createAuthRouter>;
let clients: ReturnType<
  typeof import("../../src/routes/clients").createClientsRouter
>;
beforeAll(async () => {
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET = "email-tests-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "email-tests-refresh-secret-at-least-32-bytes";
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.FRONTEND_URL = "http://localhost:3000";
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  auth = (await import("../../src/routes/auth")).createAuthRouter(database);
  clients = (await import("../../src/routes/clients")).createClientsRouter(
    database,
  );
}, 30_000);
beforeEach(async () => {
  await database.delete(emailJobs);
  await database.delete(emailVerificationTokens);
  await database.delete(passwordResetTokens);
  await database.delete(users);
});
afterAll(() => context.close());

async function account() {
  const result = await registerWithPassword(database, {
    email: `${randomUUID()}@example.test`,
    fullName: "Test <Owner>",
    password,
  });
  const job = (await database.query.emailJobs.findFirst({
    where: eq(emailJobs.userId, result.user.id),
  }))!;
  const message = decryptEmail(job.id, job.payload!);
  const token = /#token=([a-f0-9]{64})/.exec(message.html)![1];
  return { ...result, job, message, token };
}
async function plainJob() {
  const id = randomUUID();
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, fullName: "Queue Test" });
  return enqueueEmail(database, {
    userId: id,
    purpose: "invoice",
    message: {
      to: "recipient@example.test",
      subject: "Invoice",
      html: "<p>Invoice</p>",
    },
  });
}
async function saved(id: string) {
  return (await database.query.emailJobs.findFirst({
    where: eq(emailJobs.id, id),
  }))!;
}
const accepted = async () => ({
  accepted: true as const,
  id: "provider-message",
});

test("stopping the live queue loop commits its active acceptance and leaves new jobs pending", async () => {
  const first = await plainJob();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const delivered = new Promise<void>((done) => {
    release = done;
  });
  const stop = startEmailWorker(
    database,
    (db) =>
      processNextEmail(db, async () => {
        enter();
        await delivered;
        return accepted();
      }),
    5,
  );
  try {
    await entered;
    const second = await plainJob();
    let finished = false;
    const stopping = stop().then(() => {
      finished = true;
    });
    await Bun.sleep(10);
    expect(finished).toBe(false);
    release();
    await stopping;
    await Bun.sleep(15);
    expect((await saved(first.id)).status).toBe("accepted");
    expect((await saved(second.id)).status).toBe("pending");
  } finally {
    release();
    await stop();
  }
});

test("registration atomically creates one hashed verification token and encrypted queued email", async () => {
  const { user, job, token, message } = await account();
  const stored = await database.query.emailVerificationTokens.findFirst({
    where: eq(emailVerificationTokens.userId, user.id),
  });
  expect(stored?.tokenHash).not.toBe(token);
  expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(user.emailVerifiedAt).toBeNull();
  expect(job.payload).not.toContain(token);
  expect(job.payload).not.toContain(user.email);
  expect(message.html).toContain("Test &lt;Owner&gt;");
  expect(message.html).toContain("/verify-email#token=");
});

test("unverified accounts can sign in and see their profile but cannot access clients or invoices", async () => {
  const { session } = await account();
  const headers = { Cookie: `access_token=${session.accessToken}` };
  expect((await auth.request("/me", { headers })).status).toBe(200);
  expect((await clients.request("/", { headers })).status).toBe(403);
  const invoices = (
    await import("../../src/routes/invoices")
  ).createInvoicesRouter(database);
  expect((await invoices.request("/", { headers })).status).toBe(403);
  expect(
    (
      await auth.request("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: (await database.query.users.findFirst())!.email,
          password,
        }),
      })
    ).status,
  ).toBe(200);
});

test("verification requires the matching session, consumes once, and unlocks existing sessions", async () => {
  const { user, token, session } = await account();
  expect(
    (
      await auth.request("/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(401);
  const headers = {
    Cookie: `access_token=${session.accessToken}`,
    "Content-Type": "application/json",
  };
  const response = await auth.request("/verify-email", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  expect((await clients.request("/", { headers })).status).toBe(200);
  expect(
    (await database.query.users.findFirst({ where: eq(users.id, user.id) }))!
      .emailVerifiedAt,
  ).toBeInstanceOf(Date);
  await expect(verifyEmail(database, user.id, token)).rejects.toThrow(
    "Invalid or expired",
  );
});

test("expired, changed-email, and cross-account tokens cannot verify an account", async () => {
  const a = await account(),
    b = await account();
  await expect(verifyEmail(database, b.user.id, a.token)).rejects.toThrow();
  await database
    .update(users)
    .set({ email: "changed@example.test" })
    .where(eq(users.id, a.user.id));
  await expect(verifyEmail(database, a.user.id, a.token)).rejects.toThrow();
  await client`update email_verification_tokens set expires_at = now() - interval '1 second' where user_id = ${b.user.id}`;
  await expect(verifyEmail(database, b.user.id, b.token)).rejects.toThrow();
});

test("concurrent verification has one winner and cancels unneeded queued links", async () => {
  const { user, token, job } = await account();
  const results = await Promise.allSettled([
    verifyEmail(database, user.id, token),
    verifyEmail(database, user.id, token),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await saved(job.id)).status).toBe("cancelled");
  expect((await saved(job.id)).payload).toBeNull();
});

test("resends have a cooldown, invalidate older links, and serialize concurrent requests", async () => {
  const { user, token, job } = await account();
  await expect(resendVerification(database, user.id)).rejects.toThrow(
    "one minute",
  );
  await client`update email_verification_tokens set created_at = now() - interval '2 minutes' where user_id = ${user.id}`;
  const results = await Promise.allSettled([
    resendVerification(database, user.id),
    resendVerification(database, user.id),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await saved(job.id)).status).toBe("cancelled");
  await expect(verifyEmail(database, user.id, token)).rejects.toThrow();
  expect(await database.query.emailVerificationTokens.findMany()).toHaveLength(
    1,
  );
});

test("queue insertion failure rolls registration and its token back", async () => {
  await client.unsafe(
    "CREATE FUNCTION fail_email_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enqueue failure'; END $$; CREATE TRIGGER fail_email BEFORE INSERT ON email_jobs FOR EACH ROW EXECUTE FUNCTION fail_email_insert()",
  );
  try {
    await expect(
      registerWithPassword(database, {
        email: "rollback@example.test",
        fullName: "Rollback",
        password,
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("injected enqueue failure") },
    });
    expect(await database.query.users.findMany()).toHaveLength(0);
    expect(
      await database.query.emailVerificationTokens.findMany(),
    ).toHaveLength(0);
  } finally {
    await client.unsafe(
      "DROP TRIGGER fail_email ON email_jobs; DROP FUNCTION fail_email_insert()",
    );
  }
});

test("reset tokens and delivery jobs commit together and cancel superseded email", async () => {
  const { user } = await account();
  const first = await requestPasswordReset(database, user.email);
  const old = (await database.query.emailJobs.findFirst({
    where: and(
      eq(emailJobs.userId, user.id),
      eq(emailJobs.purpose, "password_reset"),
    ),
  }))!;
  await requestPasswordReset(database, user.email);
  expect((await saved(old.id)).status).toBe("cancelled");
  expect((await saved(old.id)).payload).toBeNull();
  expect(await database.query.passwordResetTokens.findMany()).toHaveLength(1);
  expect(
    JSON.stringify(await database.query.emailJobs.findMany()),
  ).not.toContain(first!.rawToken);
});

test("concurrent workers claim a job once and erase its content only after provider acceptance", async () => {
  const job = await plainJob();
  let calls = 0;
  const send = async () => {
    calls++;
    await Bun.sleep(20);
    return accepted();
  };
  await Promise.all([
    processNextEmail(database, send),
    processNextEmail(database, send),
  ]);
  expect(calls).toBe(1);
  const row = await saved(job.id);
  expect(row.status).toBe("accepted");
  expect(row.providerMessageId).toBe("provider-message");
  expect(row.payload).toBeNull();
});

test("transient failures preserve identical payloads and idempotency keys for retry", async () => {
  const job = await plainJob();
  const requests: string[] = [];
  await processNextEmail(database, async (message, key) => {
    requests.push(JSON.stringify({ message, key }));
    return { accepted: false, retryable: true, code: "provider_429" };
  });
  expect((await saved(job.id)).status).toBe("pending");
  expect((await saved(job.id)).payload).not.toBeNull();
  expect((await saved(job.id)).nextAttemptAt.getTime()).toBeGreaterThan(
    Date.now(),
  );
  await client`update email_jobs set next_attempt_at = now() where id = ${job.id}`;
  await processNextEmail(database, async (message, key) => {
    requests.push(JSON.stringify({ message, key }));
    return accepted();
  });
  expect(requests[0]).toBe(requests[1]);
  expect((await saved(job.id)).attempts).toBe(2);
});

test("expired leases recover a crash with the original idempotency key", async () => {
  const job = await plainJob();
  await client`update email_jobs set status = 'processing', attempts = 1, claim_id = 'dead-worker', locked_until = now() - interval '1 second' where id = ${job.id}`;
  let key = "";
  await processNextEmail(database, async (_, value) => {
    key = value;
    return accepted();
  });
  expect(key).toBe(`billd-email/${job.id}`);
  expect((await saved(job.id)).status).toBe("accepted");
});

test("an acknowledgement failure can retry safely after provider acceptance", async () => {
  const job = await plainJob();
  const keys: string[] = [];
  await client.unsafe(
    "CREATE FUNCTION fail_email_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'accepted' THEN RAISE EXCEPTION 'injected ack failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_ack BEFORE UPDATE ON email_jobs FOR EACH ROW EXECUTE FUNCTION fail_email_ack()",
  );
  try {
    await expect(
      processNextEmail(database, async (_, key) => {
        keys.push(key);
        return accepted();
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("injected ack failure") },
    });
  } finally {
    await client.unsafe(
      "DROP TRIGGER fail_ack ON email_jobs; DROP FUNCTION fail_email_ack()",
    );
  }
  await client`update email_jobs set locked_until = now() - interval '1 second' where id = ${job.id}`;
  await processNextEmail(database, async (_, key) => {
    keys.push(key);
    return accepted();
  });
  expect(keys[0]).toBe(keys[1]);
});

test("permanent failures, attempt exhaustion, and job expiry stop retries and clear payloads", async () => {
  const permanent = await plainJob();
  await processNextEmail(database, async () => ({
    accepted: false,
    retryable: false,
    code: "provider_403",
  }));
  expect((await saved(permanent.id)).status).toBe("failed");
  expect((await saved(permanent.id)).payload).toBeNull();
  const exhausted = await plainJob();
  await client`update email_jobs set attempts = 5 where id = ${exhausted.id}`;
  await processNextEmail(database, async () => ({
    accepted: false,
    retryable: true,
    code: "network_error",
  }));
  expect((await saved(exhausted.id)).status).toBe("failed");
  const expired = await plainJob();
  await client`update email_jobs set expires_at = now() - interval '1 second' where id = ${expired.id}`;
  let calls = 0;
  await processNextEmail(database, async () => {
    calls++;
    return accepted();
  });
  expect(calls).toBe(0);
  expect((await saved(expired.id)).payload).toBeNull();
});

test("ciphertext tampering and swapping payloads between job IDs cannot send mail", async () => {
  const job = await plainJob();
  const cipher = encryptEmail("another-job", {
    from: "sender@example.test",
    to: "recipient@example.test",
    subject: "Secret",
    html: "Secret",
  });
  await database
    .update(emailJobs)
    .set({ payload: cipher })
    .where(eq(emailJobs.id, job.id));
  let calls = 0;
  await processNextEmail(database, async () => {
    calls++;
    return accepted();
  });
  expect(calls).toBe(0);
  expect((await saved(job.id)).lastError).toBe("invalid_payload");
});

test("cancellation during a provider call cannot resurrect a verification job", async () => {
  const { user, token, job } = await account();
  await processNextEmail(database, async () => {
    await verifyEmail(database, user.id, token);
    return accepted();
  });
  expect((await saved(job.id)).status).toBe("cancelled");
});

test("Google confirms fresh provider-verified accounts without trusting legacy database flags", async () => {
  const { createAuthRouter } = await import("../../src/routes/auth");
  const email = `${randomUUID()}@example.test`;
  const router = createAuthRouter(database, async (url) =>
    url.includes("/token")
      ? Response.json({ access_token: "test-provider-token" })
      : Response.json({
          id: "google-test-id",
          email,
          name: "Google Owner",
          verified_email: true,
        }),
  );
  const response = await router.request(
    "/google/callback?code=test&state=test-state",
    { headers: { Cookie: "oauth_state=test-state" } },
  );
  expect(response.status).toBe(302);
  const user = (await database.query.users.findFirst({
    where: eq(users.email, email),
  }))!;
  expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  expect(user.passwordHash).toBeNull();
});

test("Google cannot promote a pre-created unverified password account or accept a non-boolean verification flag", async () => {
  const { user } = await account();
  const { createAuthRouter } = await import("../../src/routes/auth");
  for (const verified_email of [true, false, "false"]) {
    const router = createAuthRouter(database, async (url) =>
      url.includes("/token")
        ? Response.json({ access_token: "test-provider-token" })
        : Response.json({
            id: "unlinked-google-id",
            email: user.email,
            name: "Google Owner",
            verified_email,
          }),
    );
    const response = await router.request(
      "/google/callback?code=test&state=test-state",
      { headers: { Cookie: "oauth_state=test-state" } },
    );
    expect(response.headers.get("Set-Cookie")).not.toContain("access_token=");
    const saved = (await database.query.users.findFirst({
      where: eq(users.id, user.id),
    }))!;
    expect(saved.emailVerifiedAt).toBeNull();
    expect(saved.googleId).toBeNull();
  }
});
