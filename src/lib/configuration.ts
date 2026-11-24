import { z } from "zod";
import { isIP } from "node:net";
import { validateAuthConfiguration } from "./jwt";
import { emailQueueKey } from "./email-queue";
import { proxyHops } from "../middleware/rate-limit";

export function applicationOrigin(
  name: string,
  value: string,
  production = false,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    /\s/.test(value) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${name} must be an HTTP(S) origin without a path, credentials, query, or fragment`,
    );
  if (
    production &&
    (url.protocol !== "https:" ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      (isIP(url.hostname) === 4 && url.hostname.startsWith("127.")) ||
      url.hostname === "[::1]")
  )
    throw new Error(
      `${name} must use HTTPS and a non-loopback hostname in production`,
    );
  return url.origin;
}

export function validateConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(mode))
    throw new Error("NODE_ENV must be development, test, or production");
  const production = mode === "production";
  validateAuthConfiguration(env);
  const portValue = env.PORT ?? "3001";
  if (
    !/^\d{1,5}$/.test(portValue) ||
    Number(portValue) > 65535 ||
    (Number(portValue) === 0 && mode !== "test")
  )
    throw new Error(
      "PORT must be an integer from 1 to 65535 (0 is allowed only in test mode)",
    );
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname ||
    database.pathname.length < 2 ||
    /\s/.test(env.DATABASE_URL ?? "")
  )
    throw new Error(
      "DATABASE_URL must include a PostgreSQL host and database name",
    );
  if (
    database.searchParams
      .getAll("sslmode")
      .some((mode) => !["require", "verify-ca", "verify-full"].includes(mode))
  )
    throw new Error(
      "DATABASE_URL sslmode must require TLS; the application requires TLS connections",
    );
  if (production && (!env.FRONTEND_URL || !env.API_URL))
    throw new Error("FRONTEND_URL and API_URL are required in production");
  const frontend = applicationOrigin(
    "FRONTEND_URL",
    env.FRONTEND_URL ?? "http://localhost:3000",
    production,
  );
  const api = applicationOrigin(
    "API_URL",
    env.API_URL ?? "http://localhost:3001",
    production,
  );
  proxyHops(env.RATE_LIMIT_PROXY_HOPS ?? "0");
  for (const name of [
    "RESEND_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "PAYSTACK_SECRET_KEY",
  ] as const) {
    const value = env[name];
    if (value && /\s/.test(value))
      throw new Error(`${name} must not contain whitespace`);
  }
  if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET))
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  if (production && !env.RESEND_API_KEY)
    throw new Error("RESEND_API_KEY is required in production");
  if (production || env.EMAIL_QUEUE_ENCRYPTION_KEY)
    emailQueueKey(env.EMAIL_QUEUE_ENCRYPTION_KEY ?? "");
  const from = env.EMAIL_FROM ?? "Billd <onboarding@resend.dev>";
  const mailbox = /^(?:[^<>\r\n]+<([^<>\s]+)>|([^<>\s]+))$/.exec(from);
  if (
    !mailbox ||
    /[\r\n]/.test(from) ||
    !z
      .string()
      .email()
      .safeParse(mailbox[1] ?? mailbox[2]).success
  )
    throw new Error(
      "EMAIL_FROM must be an email address or Name <email@example.com>",
    );
  if (env.SENTRY_DSN) {
    let dsn: URL;
    try {
      dsn = new URL(env.SENTRY_DSN);
    } catch {
      throw new Error("SENTRY_DSN must be a valid Sentry DSN");
    }
    if (
      !["http:", "https:"].includes(dsn.protocol) ||
      /\s/.test(env.SENTRY_DSN) ||
      !dsn.username ||
      !/^\w+$/.test(dsn.username) ||
      !/^\d+$/.test(dsn.pathname.split("/").at(-1) ?? "") ||
      dsn.pathname === "/" ||
      dsn.search ||
      dsn.hash ||
      (production && dsn.protocol !== "https:")
    )
      throw new Error(
        "SENTRY_DSN must contain a public key and project path, using HTTPS in production",
      );
  }
  return { port: Number(portValue), frontend, api };
}
