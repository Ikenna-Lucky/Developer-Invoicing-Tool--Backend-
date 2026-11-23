import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { decodeJwt } from "jose";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import { users, refreshTokens, passwordResetTokens } from "../../src/db/schema";
import {
  registerWithPassword,
  loginWithPassword,
  createSession,
  rotateSession,
  revokeSession,
  requestPasswordReset,
  resetPassword,
} from "../../src/lib/sessions";
import { hashToken, verifyRefreshToken } from "../../src/lib/jwt";
import type { DB } from "../../src/db";

const context = createTestDatabase();
const { client, database } = context;
const password = "Existing password 123";
let router: ReturnType<typeof import("../../src/routes/auth").createAuthRouter>;

beforeAll(async () => {
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET =
    "auth-integration-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "auth-integration-refresh-secret-at-least-32-bytes";
  process.env.JWT_ACCESS_EXPIRES_IN = "15m";
  process.env.JWT_REFRESH_EXPIRES_IN = "7d";
  delete process.env.RESEND_API_KEY;
  router = (await import("../../src/routes/auth")).createAuthRouter(database);
}, 30_000);
afterAll(async () => {
  await context.close();
});

async function account() {
  const email = `${randomUUID()}@example.test`;
  return registerWithPassword(database, {
    email,
    fullName: "Test User",
    password,
  });
}

function request(
  path: string,
  token: string,
  cookie = "access_token",
  method = "GET",
) {
  return router.request(path, {
    method,
    headers: { Cookie: `${cookie}=${token}` },
  });
}

test("production auth keeps secure cookies and canonical OAuth redirect origins", async () => {
  const { user } = await account();
  const names = [
    "NODE_ENV",
    "FRONTEND_URL",
    "API_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      FRONTEND_URL: "https://app.example.test/",
      API_URL: "https://api.example.test/",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    });
    const { createAuthRouter } = await import("../../src/routes/auth");
    const production = createAuthRouter(database);
    const login = await production.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.getSetCookie()).toHaveLength(2);
    for (const cookie of login.headers.getSetCookie()) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=None");
    }
    const google = await production.request("/google");
    expect(google.status).toBe(302);
    const redirect = new URL(google.headers.get("Location")!);
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      "https://api.example.test/auth/google/callback",
    );
    expect(google.headers.get("Set-Cookie")).toContain("Secure");
    expect(google.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    const cancelled = await production.request(
      "/google/callback?error=access_denied",
    );
    expect(cancelled.headers.get("Location")).toBe(
      "https://app.example.test/sign-in?error=google_denied",
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("concurrent logins create distinct sessions without token hash collisions", async () => {
  const { user } = await account();
  const logins = await Promise.all(
    Array.from({ length: 3 }, () =>
      loginWithPassword(database, {
        email: user.email,
        password,
        rememberMe: false,
      }),
    ),
  );
  expect(
    new Set(logins.map((login) => hashToken(login.session.refreshToken))).size,
  ).toBe(3);
  expect(
    new Set(
      await Promise.all(
        logins.map(
          async (login) =>
            (await verifyRefreshToken(login.session.refreshToken)).sessionId,
        ),
      ),
    ).size,
  ).toBe(3);
});

test("concurrent refreshes accept one request without clearing its cookies", async () => {
  const { session } = await account();
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      request("/refresh", session.refreshToken, "refresh_token", "POST"),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 401,
  ]);
  expect(
    responses
      .find((response) => response.status === 401)!
      .headers.getSetCookie(),
  ).toHaveLength(0);
  const winner = responses.find((response) => response.status === 200)!;
  expect(winner.headers.getSetCookie()).toHaveLength(2);
  expect((await request("/me", session.accessToken)).status).toBe(200);
  await expect(rotateSession(database, session.refreshToken)).rejects.toThrow(
    "no longer valid",
  );
});

test("remembered session deadlines survive rotation and match JWT and database expiry", async () => {
  const { user } = await account();
  const { session } = await loginWithPassword(database, {
    email: user.email,
    password,
    rememberMe: true,
  });
  const rotated = await rotateSession(database, session.refreshToken);
  expect(rotated.refreshExpiresAt.getTime()).toBe(
    session.refreshExpiresAt.getTime(),
  );
  expect(decodeJwt(rotated.refreshToken).exp! * 1000).toBe(
    session.refreshExpiresAt.getTime(),
  );
  const stored = await database.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(rotated.refreshToken)),
  });
  expect(stored?.expiresAt.getTime()).toBe(session.refreshExpiresAt.getTime());
  expect(
    session.refreshExpiresAt.getTime() > Date.now() + 29 * 86_400_000,
  ).toBe(true);
});

test("failed replacement insertion rolls refresh revocation back", async () => {
  const { session } = await account();
  const claims = await verifyRefreshToken(session.refreshToken);
  await client.unsafe(`CREATE FUNCTION reject_refresh_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.session_id = '${claims.sessionId}' THEN RAISE EXCEPTION 'injected refresh failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(
    "CREATE TRIGGER test_refresh_failure BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_refresh_insert()",
  );
  try {
    await expect(rotateSession(database, session.refreshToken)).rejects.toThrow(
      "injected refresh failure",
    );
    expect(
      (
        await database.query.refreshTokens.findFirst({
          where: eq(refreshTokens.tokenHash, hashToken(session.refreshToken)),
        })
      )?.revoked,
    ).toBe(false);
    expect((await request("/me", session.accessToken)).status).toBe(200);
  } finally {
    await client.unsafe("DROP TRIGGER test_refresh_failure ON refresh_tokens");
    await client.unsafe("DROP FUNCTION reject_refresh_insert()");
  }
  expect(
    (await rotateSession(database, session.refreshToken)).refreshToken ===
      session.refreshToken,
  ).toBe(false);
});

test("logout through an older rotated token blocks that session but preserves other devices", async () => {
  const { user, session } = await account();
  const other = await createSession(database, user.id);
  const rotated = await rotateSession(database, session.refreshToken);
  const response = await request(
    "/logout",
    session.refreshToken,
    "refresh_token",
    "POST",
  );
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect((await request("/me", session.accessToken)).status).toBe(401);
  expect((await request("/me", rotated.accessToken)).status).toBe(401);
  expect((await request("/me", other.accessToken)).status).toBe(200);
  await expect(rotateSession(database, rotated.refreshToken)).rejects.toThrow(
    "no longer valid",
  );
});

test("logout and refresh racing cannot resurrect a session", async () => {
  const { session } = await account();
  const results = await Promise.allSettled([
    rotateSession(database, session.refreshToken),
    revokeSession(database, session.refreshToken),
  ]);
  expect(results[1].status).toBe("fulfilled");
  const claims = await verifyRefreshToken(session.refreshToken);
  const active = await database.query.refreshTokens.findMany({
    where: and(
      eq(refreshTokens.sessionId, claims.sessionId),
      eq(refreshTokens.revoked, false),
    ),
  });
  expect(active).toHaveLength(0);
  if (results[0].status === "fulfilled")
    expect((await request("/me", results[0].value.accessToken)).status).toBe(
      401,
    );
});

test("concurrent reset requests leave one active hashed token", async () => {
  const { user } = await account();
  const resets = await Promise.all(
    Array.from({ length: 3 }, () => requestPasswordReset(database, user.email)),
  );
  const stored = await database.query.passwordResetTokens.findMany({
    where: eq(passwordResetTokens.userId, user.id),
  });
  expect(stored).toHaveLength(1);
  expect(
    resets.filter(
      (reset) => hashToken(reset!.rawToken) === stored[0].tokenHash,
    ),
  ).toHaveLength(1);
  expect(resets.some((reset) => reset!.rawToken === stored[0].tokenHash)).toBe(
    false,
  );
});

test("a reset token can only be consumed once under concurrent requests", async () => {
  const { user, session } = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  const candidates = ["Replacement password A", "Replacement password B"];
  const results = await Promise.allSettled(
    candidates.map((candidate) =>
      resetPassword(database, reset.rawToken, candidate),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const saved = (await database.query.users.findFirst({
    where: eq(users.id, user.id),
  }))!;
  expect(saved.sessionVersion).toBe(1);
  expect(
    await bcrypt.compare(
      candidates[results.findIndex((result) => result.status === "fulfilled")],
      saved.passwordHash!,
    ),
  ).toBe(true);
  expect(
    await database.query.passwordResetTokens.findMany({
      where: eq(passwordResetTokens.userId, user.id),
    }),
  ).toHaveLength(0);
  expect(
    await database.query.refreshTokens.findMany({
      where: eq(refreshTokens.userId, user.id),
    }),
  ).toHaveLength(0);
  expect((await request("/me", session.accessToken)).status).toBe(401);
  await expect(rotateSession(database, session.refreshToken)).rejects.toThrow(
    "no longer valid",
  );
  await expect(
    loginWithPassword(database, {
      email: user.email,
      password,
      rememberMe: false,
    }),
  ).rejects.toThrow("Invalid email or password");
});

test("an expired reset link does not alter passwords or sessions", async () => {
  const { user, session } = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  await database
    .update(passwordResetTokens)
    .set({ expiresAt: new Date(0) })
    .where(eq(passwordResetTokens.userId, user.id));
  await expect(
    resetPassword(database, reset.rawToken, "Replacement password"),
  ).rejects.toThrow("Invalid or expired");
  expect((await request("/me", session.accessToken)).status).toBe(200);
  expect(
    (await database.query.users.findFirst({ where: eq(users.id, user.id) }))
      ?.sessionVersion,
  ).toBe(0);
});

test("reset failure rolls back the password, token consumption, and session removal", async () => {
  const { user, session } = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  await client.unsafe(`CREATE FUNCTION reject_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.user_id = '${user.id}' THEN RAISE EXCEPTION 'injected reset failure'; END IF; RETURN OLD; END $$`);
  await client.unsafe(
    "CREATE TRIGGER test_reset_failure BEFORE DELETE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_session_delete()",
  );
  try {
    await expect(
      resetPassword(database, reset.rawToken, "Replacement password"),
    ).rejects.toThrow("injected reset failure");
    const saved = (await database.query.users.findFirst({
      where: eq(users.id, user.id),
    }))!;
    expect(saved.sessionVersion).toBe(0);
    expect(saved.passwordHash).toBe(user.passwordHash);
    expect(
      await database.query.passwordResetTokens.findMany({
        where: eq(passwordResetTokens.userId, user.id),
      }),
    ).toHaveLength(1);
    expect((await request("/me", session.accessToken)).status).toBe(200);
  } finally {
    await client.unsafe("DROP TRIGGER test_reset_failure ON refresh_tokens");
    await client.unsafe("DROP FUNCTION reject_session_delete()");
  }
  await resetPassword(database, reset.rawToken, "Replacement password");
  expect((await request("/me", session.accessToken)).status).toBe(401);
});

test("refresh racing a reset cannot leave an active old-password session", async () => {
  const { user, session } = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  const results = await Promise.allSettled([
    rotateSession(database, session.refreshToken),
    resetPassword(database, reset.rawToken, "Replacement password"),
  ]);
  expect(results[1].status).toBe("fulfilled");
  expect(
    await database.query.refreshTokens.findMany({
      where: eq(refreshTokens.userId, user.id),
    }),
  ).toHaveLength(0);
  if (results[0].status === "fulfilled")
    expect((await request("/me", results[0].value.accessToken)).status).toBe(
      401,
    );
});

test("login racing a reset cannot authenticate an old password after the reset commits", async () => {
  const { user } = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  const results = await Promise.allSettled([
    loginWithPassword(database, {
      email: user.email,
      password,
      rememberMe: false,
    }),
    resetPassword(database, reset.rawToken, "Replacement password"),
  ]);
  expect(results[1].status).toBe("fulfilled");
  if (results[0].status === "fulfilled")
    expect(
      (await request("/me", results[0].value.session.accessToken)).status,
    ).toBe(401);
  const login = await loginWithPassword(database, {
    email: user.email,
    password: "Replacement password",
    rememberMe: false,
  });
  expect((await request("/me", login.session.accessToken)).status).toBe(200);
});

test("registration rolls back the account when session persistence fails", async () => {
  const email = `${randomUUID()}@example.test`;
  await client.unsafe(
    "CREATE FUNCTION reject_registration_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected registration failure'; END $$",
  );
  await client.unsafe(
    "CREATE TRIGGER test_registration_failure BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION reject_registration_session()",
  );
  try {
    await expect(
      registerWithPassword(database, {
        email,
        fullName: "Test User",
        password,
      }),
    ).rejects.toThrow("injected registration failure");
    expect(
      await database.query.users.findFirst({ where: eq(users.email, email) }),
    ).toBe(undefined);
  } finally {
    await client.unsafe(
      "DROP TRIGGER test_registration_failure ON refresh_tokens",
    );
    await client.unsafe("DROP FUNCTION reject_registration_session()");
  }
});

test("unknown and Google-only accounts cannot receive password reset tokens", async () => {
  expect(await requestPasswordReset(database, "unknown@example.test")).toBe(
    null,
  );
  const email = `${randomUUID()}@example.test`;
  await database.insert(users).values({
    id: randomUUID(),
    email,
    fullName: "Google User",
    googleId: randomUUID(),
  });
  expect(await requestPasswordReset(database, email)).toBe(null);
});

test("HTTP cookies match configured lifetimes and remembered expiry after refresh", async () => {
  const { user } = await account();
  const response = await router.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password, rememberMe: true }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  const refresh = cookies.find((cookie) =>
    cookie.startsWith("refresh_token="),
  )!;
  const access = cookies.find((cookie) => cookie.startsWith("access_token="))!;
  const refreshAge = Number(/Max-Age=(\d+)/.exec(refresh)![1]);
  const accessAge = Number(/Max-Age=(\d+)/.exec(access)![1]);
  expect(refreshAge <= 2_592_000 && refreshAge >= 2_591_995).toBe(true);
  expect(accessAge <= 900 && accessAge >= 895).toBe(true);
  expect(access.includes("HttpOnly") && refresh.includes("HttpOnly")).toBe(
    true,
  );
  const rawToken = refresh.split(";")[0].slice("refresh_token=".length);
  const rotated = await request("/refresh", rawToken, "refresh_token", "POST");
  expect(rotated.status).toBe(200);
  const next = rotated.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("refresh_token="))!
    .split(";")[0]
    .slice("refresh_token=".length);
  expect(decodeJwt(next).exp).toBe(decodeJwt(rawToken).exp);
});

test("access token expiry cannot outlive a session near its deadline", async () => {
  const { session } = await account();
  const deadline = new Date((Math.floor(Date.now() / 1000) + 60) * 1000);
  await database
    .update(refreshTokens)
    .set({ expiresAt: deadline })
    .where(eq(refreshTokens.tokenHash, hashToken(session.refreshToken)));
  const rotated = await rotateSession(database, session.refreshToken);
  expect(rotated.accessExpiresAt.getTime()).toBe(deadline.getTime());
  expect(decodeJwt(rotated.accessToken).exp! * 1000).toBe(deadline.getTime());
});

test("reset HTTP success clears cookies and invalidates every session for only that account", async () => {
  const { user, session } = await account();
  const otherDevice = await createSession(database, user.id);
  const otherAccount = await account();
  const reset = (await requestPasswordReset(database, user.email))!;
  const response = await router.request("/reset-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `access_token=${session.accessToken}`,
    },
    body: JSON.stringify({
      token: reset.rawToken,
      password: "Replacement password",
    }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect((await request("/me", session.accessToken)).status).toBe(401);
  expect((await request("/me", otherDevice.accessToken)).status).toBe(401);
  expect((await request("/me", otherAccount.session.accessToken)).status).toBe(
    200,
  );
  expect(
    (
      await router.request("/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: reset.rawToken,
          password: "Another password",
        }),
      })
    ).status,
  ).toBe(400);
});

test("logout does not claim success or clear retry credentials when revocation fails", async () => {
  const fakeDatabase = {
    query: {
      refreshTokens: {
        findFirst: async () => {
          throw new Error("Injected database outage");
        },
      },
    },
  } as unknown as DB;
  const failing = (await import("../../src/routes/auth")).createAuthRouter(
    fakeDatabase,
  );
  const response = await failing.request("/logout", {
    method: "POST",
    headers: { Cookie: "refresh_token=not-logged-or-used" },
  });
  expect(response.status).toBe(503);
  expect(response.headers.getSetCookie()).toHaveLength(0);
});

test("a database outage during session checks returns 500 rather than invalidating the credentials", async () => {
  const { session } = await account();
  const fakeDatabase = {
    select: () => {
      throw new Error("Injected database outage");
    },
  } as unknown as DB;
  const failing = (await import("../../src/routes/auth")).createAuthRouter(
    fakeDatabase,
  );
  const response = await failing.request("/me", {
    headers: { Cookie: `access_token=${session.accessToken}` },
  });
  expect(response.status).toBe(500);
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect((await request("/me", session.accessToken)).status).toBe(200);
});
