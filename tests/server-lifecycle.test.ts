import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

async function remainingOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function startApi() {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/shutdown-api.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
        JWT_ACCESS_SECRET: "lifecycle-access-secret-at-least-32-bytes",
        JWT_REFRESH_SECRET: "lifecycle-refresh-secret-at-least-32-bytes",
        RESEND_API_KEY: "",
        EMAIL_QUEUE_ENCRYPTION_KEY: "",
        SENTRY_DSN: "",
        PAYSTACK_SECRET_KEY: "",
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        EMAIL_FROM: "onboarding@resend.dev",
        FRONTEND_URL: "http://localhost:3000",
        API_URL: "http://localhost:3001",
        RATE_LIMIT_PROXY_HOPS: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("API exited before startup");
      text += decoder.decode(value, { stream: true });
      const line = text
        .split("\n")
        .find((line) => line.includes('"fixture.started"'));
      if (line)
        return { child, url: `http://127.0.0.1:${JSON.parse(line).port}` };
    }
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

test("the actual API entry serves liveness during a DB outage and closes cleanly on its shutdown handler", async () => {
  const { child, url } = await startApi();
  try {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    const readiness = await fetch(`${url}/health/ready`, {
      signal: AbortSignal.timeout(4000),
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ status: "unavailable" });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    const output = remainingOutput(child.stdout);
    const errors = new Response(child.stderr).text();
    child.stdin.write("stop\n");
    expect(await child.exited).toBe(0);
    expect(await output).toContain('"event":"api.stopped"');
    expect(await errors).toBe("");
    await expect(
      fetch(`${url}/health`, { signal: AbortSignal.timeout(250) }),
    ).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 10_000);

test.skipIf(process.platform === "win32")(
  "an OS SIGTERM exits the actual Bun API cleanly",
  async () => {
    const { child } = await startApi();
    try {
      const output = remainingOutput(child.stdout);
      const errors = new Response(child.stderr).text();
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await output).toContain('"event":"api.stopped"');
      expect(await errors).toBe("");
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  },
  10_000,
);
