import { expect, test, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  requestLogging,
  reportError,
  setErrorReporter,
} from "../src/lib/observability";
import { sanitizeMonitoringEvent } from "../src/instrumentation";
import { fileURLToPath } from "node:url";

test("concurrent requests get independent server IDs and logs exclude request secrets", async () => {
  const lines: string[] = [];
  const output = spyOn(console, "log").mockImplementation((line) => {
    lines.push(line);
  });
  const errors = spyOn(console, "error").mockImplementation((line) => {
    lines.push(line);
  });
  const reports: string[] = [];
  setErrorReporter((_event, id) => {
    reports.push(id!);
  });
  try {
    const app = new Hono();
    app.use("*", requestLogging());
    app.get("/private/:token", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      reportError("request.failed");
      return c.json({ ok: false }, 500);
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.request("/private/secret?token=secret", {
          headers: {
            Cookie: "token=secret",
            "X-Request-ID": "secret",
            Authorization: "Bearer secret",
          },
        }),
      ),
    );
    const ids = responses.map((r) => r.headers.get("X-Request-ID"));
    expect(new Set(ids).size).toBe(10);
    expect(new Set(reports)).toEqual(new Set(ids as string[]));
    expect(lines.join("\n")).not.toContain("secret");
    expect(
      lines.filter((l) => JSON.parse(l).event === "request.completed"),
    ).toHaveLength(10);
  } finally {
    output.mockRestore();
    errors.mockRestore();
    setErrorReporter(undefined);
  }
});

test("monitoring outages do not replace application responses", async () => {
  const output = spyOn(console, "error").mockImplementation(() => {});
  setErrorReporter(() => {
    throw new Error("monitor unavailable");
  });
  try {
    expect(() => reportError("email.worker_failed")).not.toThrow();
  } finally {
    output.mockRestore();
    setErrorReporter(undefined);
  }
});

test("Sentry events are rebuilt without request data, raw errors, variables, or provider responses", () => {
  const sanitized = sanitizeMonitoringEvent({
    type: undefined,
    message: "request.failed",
    event_id: "123",
    timestamp: 123,
    request: { url: "https://secret", cookies: { token: "secret" } },
    user: { email: "secret@example.test" },
    extra: { sql: "secret" },
    contexts: { provider: { response: "secret" } },
    breadcrumbs: [{ message: "secret" }],
    tags: {
      requestId: "12345678-1234-1234-1234-123456789abc",
      account: "secret",
    },
    exception: {
      values: [
        {
          value: "secret",
          stacktrace: {
            frames: [
              {
                filename: "C:/app/src/routes/invoices.ts",
                lineno: 40,
                function: "secret",
                vars: { token: "secret" },
                context_line: "secret",
              },
              { filename: "https://secret/evil.ts", lineno: 1 },
            ],
          },
        },
      ],
    },
  });
  expect(JSON.stringify(sanitized)).not.toContain("secret");
  expect(sanitized.exception?.values?.[0]?.stacktrace?.frames).toEqual([
    {
      filename: "src/routes/invoices.ts",
      lineno: 40,
      colno: undefined,
      in_app: true,
    },
  ]);
  expect(sanitized.tags?.requestId).toBe(
    "12345678-1234-1234-1234-123456789abc",
  );
  expect(
    sanitizeMonitoringEvent({ type: undefined, message: "password=secret" })
      .message,
  ).toBe("runtime.fatal");
});

test("the configured Sentry SDK sends only sanitized events to a local collector", async () => {
  const envelopes: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      envelopes.push(await request.text());
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/monitoring.ts", import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          SENTRY_DSN: `http://public@127.0.0.1:${server.port}/1`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.join("\n")).toContain("request.failed");
    expect(envelopes.join("\n") + stdout + stderr).not.toContain(
      "secret-provider-response",
    );
  } finally {
    server.stop(true);
  }
});

for (const mode of ["fatal", "rejection"]) {
  test(`${mode} exits with failure and writes a safe runtime event without a DSN`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/monitoring.ts", import.meta.url)),
        mode,
      ],
      {
        env: { ...process.env, NODE_ENV: "development", SENTRY_DSN: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('"event":"runtime.fatal"');
    expect(stdout + stderr).not.toContain("secret-");
  });
}
