import { boundedBody } from "./request-limits";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { getConnInfo } from "hono/bun";
import { createMiddleware } from "hono/factory";
import type { DB } from "../db";

const policies: Record<
  string,
  { limit: number; seconds: number; account?: number }
> = {
  "/auth/login": { limit: 30, seconds: 900, account: 10 },
  "/auth/register": { limit: 10, seconds: 3600 },
  "/auth/resend-verification": { limit: 10, seconds: 3600 },
  "/auth/verify-email": { limit: 30, seconds: 900 },
  "/auth/forgot-password": { limit: 10, seconds: 3600, account: 3 },
  "/auth/reset-password": { limit: 20, seconds: 900 },
  "/auth/refresh": { limit: 120, seconds: 60 },
  "/auth/google": { limit: 30, seconds: 900 },
  "/auth/google/callback": { limit: 30, seconds: 900 },
};

export function proxyHops(value = process.env.RATE_LIMIT_PROXY_HOPS ?? "0") {
  if (!/^\d$/.test(value))
    throw new Error("RATE_LIMIT_PROXY_HOPS must be an integer from 0 to 9");
  return Number(value);
}

export function clientAddress(
  peer: string | undefined,
  forwarded: string | undefined,
  hops: number,
) {
  if (hops === 0) return peer && isIP(peer) ? peer : "unknown";
  // Count from the trusted end; never use the caller-controlled leftmost entry.
  const addresses = forwarded?.split(",").map((value) => value.trim()) ?? [];
  const address = addresses[addresses.length - hops];
  return address && isIP(address) ? address : "unknown";
}

export async function consumeRateLimit(
  database: DB,
  key: string,
  limit: number,
  seconds: number,
) {
  const hash = createHash("sha256").update(key).digest("hex");
  // Bound each cleanup batch so expiry work cannot monopolize a request.
  await database.execute(sql`DELETE FROM request_rate_limits WHERE key IN (
    SELECT key FROM request_rate_limits WHERE expires_at <= now() LIMIT 100
  ) AND expires_at <= now()`);
  const rows = await database.execute(sql`
    INSERT INTO request_rate_limits (key, attempts, expires_at)
    VALUES (${hash}, 1, now() + ${seconds} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN request_rate_limits.expires_at <= now() THEN 1
        ELSE LEAST(request_rate_limits.attempts + 1, ${limit + 1}) END,
      expires_at = CASE WHEN request_rate_limits.expires_at <= now()
        THEN now() + ${seconds} * interval '1 second' ELSE request_rate_limits.expires_at END
    RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now())))) AS retry_after
  `);
  return {
    allowed: Number(rows[0].attempts) <= limit,
    retryAfter: Number(rows[0].retry_after),
  };
}

export function createAuthRateLimit(database: DB, hops = proxyHops()) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path.replace(/\/$/, "");
    const policy = policies[path];
    if (!policy || !["POST", "GET", "HEAD"].includes(c.req.method))
      return next();
    const applyLimit = async () => {
      let peer: string | undefined;
      if (c.env) peer = getConnInfo(c).remote.address;
      const address = clientAddress(
        peer,
        c.req.header("X-Forwarded-For"),
        hops,
      );
      const ip = await consumeRateLimit(
        database,
        `${path}:ip:${address}`,
        policy.limit,
        policy.seconds,
      );
      if (!ip.allowed) return ip;
      if (policy.account && c.req.method === "POST") {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return ip;
        }
        if (
          typeof body === "object" &&
          body !== null &&
          "email" in body &&
          typeof body.email === "string"
        ) {
          return consumeRateLimit(
            database,
            `${path}:email:${body.email.toLowerCase()}`,
            policy.account,
            policy.seconds,
          );
        }
      }
      return ip;
    };
    let result;
    try {
      result = await applyLimit();
    } catch {
      return c.json(
        {
          error: "Authentication is temporarily unavailable. Please try again.",
        },
        503,
      );
    }
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json(
        { error: "Too many attempts. Please try again later." },
        429,
      );
    }
    await next();
  });
}

export function createAuthBodyLimit() {
  return createMiddleware(async (c, next) => {
    if (policies[c.req.path.replace(/\/$/, "")])
      return boundedBody(16 * 1024, "Authentication request is too large")(
        c,
        next,
      );
    await next();
  });
}
