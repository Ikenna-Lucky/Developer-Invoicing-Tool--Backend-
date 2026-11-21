import { beforeAll, afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createTestDatabase } from "./database";
import {
  createCsrfProtection,
  frontendOrigin,
} from "../../src/middleware/csrf";
import {
  clientAddress,
  proxyHops,
  consumeRateLimit,
  createAuthBodyLimit,
  createAuthRateLimit,
} from "../../src/middleware/rate-limit";
import type { DB } from "../../src/db";

const context = createTestDatabase();
const { database, client } = context;
const origin = "https://billd.example";
beforeAll(async () => {
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  await context.create();
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}, 30_000);
afterAll(() => context.close());

function app(store = database, hops = 0) {
  const app = new Hono();
  app.use(
    "*",
    cors({ origin, credentials: true, exposeHeaders: ["Retry-After"] }),
  );
  app.use("*", createCsrfProtection(origin));
  app.use("*", createAuthBodyLimit());
  app.use("*", createAuthRateLimit(store, hops));
  app.all("*", async (c) => {
    if (c.req.method === "POST" && c.req.path.startsWith("/auth/"))
      await c.req.json();
    return c.json({ reached: true });
  });
  return app;
}
function request(
  app: Hono,
  path: string,
  ip = "192.0.2.1",
  headers: Record<string, string> = {},
  body = "{}",
  method = "POST",
) {
  return app.request(
    path,
    {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : body,
    },
    { requestIP: () => ({ address: ip, family: "IPv4", port: 1000 }) },
  );
}

test("CSRF rejects absent, opaque, sibling, and lookalike origins before database work", async () => {
  const broken = {
    execute: () => {
      throw Error("Must not query");
    },
  } as unknown as DB;
  for (const bad of [
    "",
    "null",
    "https://other.billd.example",
    "https://billd.example.evil",
    "http://billd.example",
  ]) {
    expect(
      (await request(app(broken), "/auth/login", undefined, { Origin: bad }))
        .status,
    ).toBe(403);
  }
  expect(
    (await app(broken).request("/clients", { method: "DELETE" })).status,
  ).toBe(403);
});

test("trusted writes, safe reads, and the exact webhook boundary reach their handlers", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    expect(
      (await request(app(), "/invoices/123", undefined, {}, "{}", method))
        .status,
    ).toBe(200);
  expect((await app().request("/auth/me")).status).toBe(200);
  expect(
    (await app().request("/webhooks/paystack", { method: "POST", body: "{}" }))
      .status,
  ).toBe(200);
  expect(
    (await app().request("/webhooks/paystack/other", { method: "POST" }))
      .status,
  ).toBe(403);
});

test("CORS preflight only permits the configured origin", async () => {
  const allowed = await request(
    app(),
    "/auth/login",
    undefined,
    { "Access-Control-Request-Method": "POST" },
    "",
    "OPTIONS",
  );
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  const denied = await request(
    app(),
    "/clients",
    undefined,
    {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "DELETE",
    },
    "",
    "OPTIONS",
  );
  expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("origin and proxy configuration reject ambiguous values and ignore untrusted IP headers", () => {
  expect(frontendOrigin("https://billd.example/")).toBe(origin);
  for (const value of [
    "https://billd.example/path",
    "https://user@billd.example",
    "https://billd.example?q=1",
    "file:///tmp/a",
  ])
    expect(() => frontendOrigin(value)).toThrow();
  for (const value of ["-1", "1.5", "10", "yes"])
    expect(() => proxyHops(value)).toThrow();
  expect(clientAddress("192.0.2.2", "1.1.1.1, 192.0.2.3", 0)).toBe("192.0.2.2");
  expect(clientAddress("192.0.2.2", "1.1.1.1, 192.0.2.3", 1)).toBe("192.0.2.3");
  expect(clientAddress("192.0.2.2", "garbage", 1)).toBe("unknown");
  expect(clientAddress("192.0.2.2", undefined, 1)).toBe("unknown");
});

test("concurrent instances admit exactly the shared quota and store hashed identifiers", async () => {
  const key = `${randomUUID()}@example.test`;
  const results = await Promise.all(
    Array.from({ length: 25 }, () => consumeRateLimit(database, key, 5, 60)),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(5);
  const rows = await client`select key from request_rate_limits`;
  expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.key))).toBe(true);
});

test("expired counters restart and cleanup removes expired buckets", async () => {
  const key = randomUUID();
  await consumeRateLimit(database, key, 1, 60);
  await client`update request_rate_limits set expires_at = now() - interval '1 second'`;
  expect((await consumeRateLimit(database, key, 1, 60)).allowed).toBe(true);
  expect((await consumeRateLimit(database, key, 1, 60)).allowed).toBe(false);
  const [row] =
    await client`select count(*)::int as count from request_rate_limits`;
  expect(row.count).toBe(1);
});

test("account quota spans IPs and email casing; throttles include retry guidance without clearing cookies", async () => {
  const email = `${randomUUID()}@example.test`;
  for (let n = 0; n < 10; n++)
    expect(
      (
        await request(
          app(),
          "/auth/login",
          `192.0.2.${n + 10}`,
          {},
          JSON.stringify({ email: n % 2 ? email.toUpperCase() : email }),
        )
      ).status,
    ).toBe(200);
  const response = await request(
    app(),
    "/auth/login",
    "192.0.2.99",
    {},
    JSON.stringify({ email }),
  );
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
    "Retry-After",
  );
});

test("IP quota cannot be bypassed with arbitrary emails or spoofed forwarding headers", async () => {
  for (let n = 0; n < 10; n++)
    expect(
      (
        await request(
          app(),
          "/auth/register",
          "198.51.100.1",
          { "X-Forwarded-For": `192.0.2.${n}` },
          JSON.stringify({ email: `${randomUUID()}@example.test` }),
        )
      ).status,
    ).toBe(200);
  expect((await request(app(), "/auth/register", "198.51.100.1")).status).toBe(
    429,
  );
  expect((await request(app(), "/auth/register", "198.51.100.2")).status).toBe(
    200,
  );
});

test("unknown accounts are throttled and HEAD OAuth requests cannot bypass quotas", async () => {
  const email = `${randomUUID()}@example.test`;
  for (let n = 0; n < 3; n++)
    expect(
      (
        await request(
          app(),
          "/auth/forgot-password",
          `203.0.113.${n + 1}`,
          {},
          JSON.stringify({ email }),
        )
      ).status,
    ).toBe(200);
  expect(
    (
      await request(
        app(),
        "/auth/forgot-password",
        "203.0.113.9",
        {},
        JSON.stringify({ email }),
      )
    ).status,
  ).toBe(429);
  for (let n = 0; n < 30; n++)
    expect(
      (await request(app(), "/auth/google", "203.0.113.99", {}, "", "HEAD"))
        .status,
    ).toBe(200);
  expect(
    (await request(app(), "/auth/google", "203.0.113.99", {}, "", "GET"))
      .status,
  ).toBe(429);
});

test("limiter outages fail closed without blocking logout, health, or webhook validation", async () => {
  const broken = {
    execute: () => {
      throw Error("Database down");
    },
  } as unknown as DB;
  expect((await request(app(broken), "/auth/login")).status).toBe(503);
  for (const path of ["/auth/logout", "/webhooks/paystack"])
    expect((await request(app(broken), path)).status).toBe(200);
  expect((await app(broken).request("/health")).status).toBe(200);
});

test("oversized authentication requests are rejected before persistence", async () => {
  const broken = {
    execute: () => {
      throw Error("Must not query");
    },
  } as unknown as DB;
  const body = JSON.stringify({ email: "a".repeat(17000) });
  expect(
    (
      await request(
        app(broken),
        "/auth/login",
        undefined,
        { "Content-Length": String(body.length) },
        body,
      )
    ).status,
  ).toBe(413);
  expect(
    (await request(app(), "/auth/login", "198.51.100.123", {}, body)).status,
  ).toBe(413);
});

test("security middleware preserves request bodies through real registration and login", async () => {
  process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";
  process.env.JWT_ACCESS_SECRET =
    "security-test-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET =
    "security-test-refresh-secret-at-least-32-bytes";
  const { createAuthRouter } = await import("../../src/routes/auth");
  const secured = new Hono();
  secured.use("*", createCsrfProtection(origin));
  secured.use("*", createAuthBodyLimit());
  secured.use("*", createAuthRateLimit(database, 0));
  secured.route("/auth", createAuthRouter(database));
  const email = `${randomUUID()}@example.test`;
  const body = JSON.stringify({
    email,
    password: "Security test password 123",
    fullName: "Test Owner",
  });
  const registered = await request(
    secured,
    "/auth/register",
    "198.51.100.200",
    {},
    body,
  );
  expect(registered.status).toBe(201);
  expect(registered.headers.get("Set-Cookie")).toContain("refresh_token=");
  expect(
    (await request(secured, "/auth/login", "198.51.100.200", {}, body)).status,
  ).toBe(200);
  expect(
    (await request(secured, "/auth/login", "198.51.100.200", {}, "{")).status,
  ).toBe(400);
});
