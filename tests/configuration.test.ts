import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  applicationOrigin,
  validateConfiguration,
} from "../src/lib/configuration";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "3001",
    DATABASE_URL:
      "postgresql://ci:private-password@127.0.0.1:1/unused?sslmode=require",
    JWT_ACCESS_SECRET: "configuration-access-secret-at-least-32-bytes",
    JWT_REFRESH_SECRET: "configuration-refresh-secret-at-least-32-bytes",
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_EXPIRES_IN: "7d",
    FRONTEND_URL: "https://app.example.test/",
    API_URL: "https://api.example.test/",
    RESEND_API_KEY: "re_test-key",
    EMAIL_QUEUE_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
    EMAIL_FROM: "Billd <onboarding@resend.dev>",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    PAYSTACK_SECRET_KEY: "",
    SENTRY_DSN: "",
    RATE_LIMIT_PROXY_HOPS: "0",
  };
}

test("production configuration accepts the default Resend sender and normalizes origins", () => {
  expect(validateConfiguration(environment())).toEqual({
    port: 3001,
    frontend: "https://app.example.test",
    api: "https://api.example.test",
  });
  const optional = {
    ...environment(),
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    PAYSTACK_SECRET_KEY: "sk_test_key",
    SENTRY_DSN: "https://publickey@sentry.example.test/123",
    RATE_LIMIT_PROXY_HOPS: "2",
  };
  expect(validateConfiguration(optional).port).toBe(3001);
});

test("production requires explicit HTTPS origins without credentials, paths, or localhost", () => {
  for (const name of ["FRONTEND_URL", "API_URL"]) {
    for (const value of [
      undefined,
      "",
      "bad-url-private-data",
      "https://app.exa\nmple.test",
      "http://app.example.test",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://app.example.test/path",
      "https://user:private-password@app.example.test",
      "https://app.example.test?token=private-token",
      "https://app.example.test/#fragment",
    ]) {
      expect(() =>
        validateConfiguration({ ...environment(), [name]: value }),
      ).toThrow(name);
    }
  }
});

test("startup rejects malformed modes, ports, database URLs, and proxy settings", () => {
  for (const [name, values] of Object.entries({
    NODE_ENV: ["Production", "staging", ""],
    PORT: ["0", "-1", "65536", "3001abc", "1.5", "", " 3001"],
    DATABASE_URL: [
      "",
      "postgresql://",
      "https://host/private",
      "postgresql://host/",
      "postgresql://host/db?sslmode=disable",
    ],
    RATE_LIMIT_PROXY_HOPS: ["-1", "10", "1.0", ""],
  })) {
    for (const value of values)
      expect(() =>
        validateConfiguration({ ...environment(), [name]: value }),
      ).toThrow(name);
  }
});

test("provider pairs, sender addresses, and optional monitoring configuration fail safely", () => {
  const cases: [string, Partial<NodeJS.ProcessEnv>][] = [
    ["GOOGLE_CLIENT", { GOOGLE_CLIENT_ID: "client-only" }],
    ["GOOGLE_CLIENT", { GOOGLE_CLIENT_SECRET: "secret-only" }],
    ["RESEND_API_KEY", { RESEND_API_KEY: "" }],
    ["RESEND_API_KEY", { RESEND_API_KEY: " re_private" }],
    ["PAYSTACK_SECRET_KEY", { PAYSTACK_SECRET_KEY: "private\nheader" }],
    [
      "EMAIL_QUEUE_ENCRYPTION_KEY",
      { EMAIL_QUEUE_ENCRYPTION_KEY: "invalid-private-key" },
    ],
    ["EMAIL_FROM", { EMAIL_FROM: "Name <invalid>" }],
    ["EMAIL_FROM", { EMAIL_FROM: "sender@example.test\n" }],
    [
      "EMAIL_FROM",
      { EMAIL_FROM: "Name\r\nBcc: private@example.test <sender@example.test>" },
    ],
    ["SENTRY_DSN", { SENTRY_DSN: "private-invalid-dsn" }],
    ["SENTRY_DSN", { SENTRY_DSN: "https://publickey@host/not-a-project-id" }],
    ["SENTRY_DSN", { SENTRY_DSN: "http://publickey@host/123" }],
  ];
  for (const [name, changes] of cases)
    expect(() =>
      validateConfiguration({ ...environment(), ...changes }),
    ).toThrow(name);
});

test("existing token and encryption checks remain part of startup validation", () => {
  expect(() =>
    validateConfiguration({ ...environment(), JWT_ACCESS_SECRET: "short" }),
  ).toThrow("JWT_ACCESS_SECRET");
  expect(() =>
    validateConfiguration({
      ...environment(),
      JWT_ACCESS_SECRET: " ".repeat(40),
    }),
  ).toThrow("JWT_ACCESS_SECRET");
  expect(() =>
    validateConfiguration({
      ...environment(),
      JWT_REFRESH_SECRET: environment().JWT_ACCESS_SECRET,
    }),
  ).toThrow("different secrets");
  expect(() =>
    validateConfiguration({
      ...environment(),
      JWT_ACCESS_EXPIRES_IN: "forever",
    }),
  ).toThrow("Token lifetimes");
});

test("local development retains HTTP defaults and test mode supports an ephemeral port", () => {
  const env = environment();
  env.NODE_ENV = "development";
  delete env.FRONTEND_URL;
  delete env.API_URL;
  expect(validateConfiguration(env).frontend).toBe("http://localhost:3000");
  expect(
    validateConfiguration({ ...env, NODE_ENV: "test", PORT: "0" }).port,
  ).toBe(0);
  expect(applicationOrigin("API_URL", "https://api.example.test/")).toBe(
    "https://api.example.test",
  );
});

test("both server entries reject bad configuration before listening or running migrations without printing secrets", async () => {
  for (const entry of ["../src/index.ts", "../scripts/start.ts"]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...environment(),
      FRONTEND_URL: "https://user:private-password@app.example.test",
    };
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL(entry, import.meta.url))],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    try {
      expect(await child.exited).not.toBe(0);
      const text = (await output) + (await errors);
      expect(text).toContain("FRONTEND_URL");
      for (const secret of [
        "private-password",
        env.JWT_ACCESS_SECRET!,
        env.RESEND_API_KEY!,
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toContain('"api.started"');
      expect(text).not.toContain("CONNECTION_REFUSED");
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
}, 10_000);
