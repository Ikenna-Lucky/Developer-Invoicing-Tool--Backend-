import { expect, test } from "bun:test";
import { createShutdown } from "../src/lib/shutdown";
import { startEmailWorker } from "../src/lib/email-queue";
import type { DB } from "../src/db";
import { createHealthRouter } from "../src/routes/health";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown stops admission once and drains HTTP and email before closing dependencies", async () => {
  const http = deferred(),
    job = deferred();
  const events: string[] = [];
  const lifecycle = createShutdown(
    {
      server: {
        stop: async (force) => {
          events.push(force ? "http.force" : "http.stop");
          await http.promise;
        },
      },
      stopEmailWorker: async () => {
        events.push("worker.stop");
        await job.promise;
      },
      closeReadiness: async () => {
        events.push("probe.close");
      },
      stopPdf: async () => {
        events.push("pdf.close");
      },
      closeDatabase: async () => {
        events.push("db.close");
      },
      flushMonitoring: async () => {
        events.push("monitor.flush");
      },
      exit: (code) => {
        events.push(`exit.${code}`);
      },
    },
    1000,
  );
  const first = lifecycle.shutdown();
  expect(lifecycle.isDraining()).toBe(true);
  expect(lifecycle.shutdown()).toBe(first);
  http.resolve();
  await Bun.sleep(5);
  expect(events).not.toContain("db.close");
  job.resolve();
  await first;
  expect(events).toEqual([
    "worker.stop",
    "http.stop",
    "probe.close",
    "pdf.close",
    "db.close",
    "monitor.flush",
    "exit.0",
  ]);
});

test("the shutdown deadline forces connections and Chromium closed and exits unsuccessfully", async () => {
  const calls: string[] = [];
  const lifecycle = createShutdown(
    {
      server: {
        stop: async (force) => {
          calls.push(force ? "http.force" : "http.stop");
          if (!force) await new Promise(() => {});
        },
      },
      stopEmailWorker: async () => {},
      closeReadiness: async () => {},
      stopPdf: async (force) => {
        calls.push(`pdf.${force}`);
      },
      closeDatabase: async () => {
        calls.push("db.close");
      },
      flushMonitoring: async () => {
        calls.push("monitor.flush");
      },
      exit: (code) => {
        calls.push(`exit.${code}`);
      },
    },
    20,
  );
  await lifecycle.shutdown();
  expect(calls).toEqual([
    "http.stop",
    "http.force",
    "pdf.true",
    "db.close",
    "exit.1",
  ]);
});

test("email worker stop waits for an active job and never claims another", async () => {
  const job = deferred(),
    entered = deferred();
  let calls = 0;
  const stop = startEmailWorker(
    {} as DB,
    async () => {
      calls++;
      entered.resolve();
      await job.promise;
      return true;
    },
    5,
  );
  try {
    await entered.promise;
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(15);
    expect(stopped).toBe(false);
    job.resolve();
    await stopping;
    await stop();
    await Bun.sleep(15);
    expect(calls).toBe(1);
  } finally {
    job.resolve();
    await stop();
  }
});

test("native Bun stop drains a streaming response before database closure", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const entered = deferred();
  let databaseClosed = false;
  let exitCode: number | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          controller.enqueue(new TextEncoder().encode("finished"));
        },
      });
      entered.resolve();
      return new Response(stream);
    },
  });
  const lifecycle = createShutdown(
    {
      server,
      stopEmailWorker: async () => {},
      closeReadiness: async () => {},
      stopPdf: async () => {},
      closeDatabase: async () => {
        databaseClosed = true;
      },
      flushMonitoring: async () => {},
      exit: (code) => {
        exitCode = code;
      },
    },
    2000,
  );
  try {
    const response = await fetch(server.url);
    await entered.promise;
    const body = response.text();
    const stopping = lifecycle.shutdown();
    await Bun.sleep(10);
    expect(databaseClosed).toBe(false);
    await expect(
      fetch(server.url, { signal: AbortSignal.timeout(250) }),
    ).rejects.toThrow();
    controller.close();
    expect(await body).toBe("finished");
    await stopping;
    expect(databaseClosed).toBe(true);
    expect(exitCode).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("liveness does not touch PostgreSQL and readiness becomes unavailable during drain", async () => {
  let calls = 0,
    draining = false,
    available = true;
  const app = createHealthRouter(
    async () => {
      calls++;
      return available;
    },
    () => draining,
  );
  expect((await app.request("/")).status).toBe(200);
  expect(calls).toBe(0);
  expect((await app.request("/ready")).status).toBe(200);
  available = false;
  const failed = await app.request("/ready");
  expect(failed.status).toBe(503);
  expect(failed.headers.get("Cache-Control")).toBe("no-store");
  expect(await failed.json()).toEqual({ status: "unavailable" });
  draining = true;
  available = true;
  const before = calls;
  expect((await app.request("/ready")).status).toBe(503);
  expect(calls).toBe(before);
  expect((await app.request("/")).status).toBe(200);
});

test("readiness rechecks drain state after its database query completes", async () => {
  const probe = deferred();
  let draining = false;
  const app = createHealthRouter(
    async () => {
      await probe.promise;
      return true;
    },
    () => draining,
  );
  const response = app.request("/ready");
  draining = true;
  probe.resolve();
  expect((await response).status).toBe(503);
});

test("cleanup failure forces termination once without claiming a clean exit", async () => {
  let forced = false;
  const codes: number[] = [];
  const lifecycle = createShutdown(
    {
      server: {
        stop: async (force) => {
          if (force) forced = true;
        },
      },
      stopEmailWorker: async () => {},
      closeReadiness: async () => {},
      stopPdf: async () => {},
      closeDatabase: async () => {
        throw new Error("injected cleanup failure");
      },
      flushMonitoring: async () => {
        throw new Error("must not flush after cleanup failed");
      },
      exit: (code) => {
        codes.push(code);
      },
    },
    1000,
  );
  await lifecycle.shutdown();
  await lifecycle.shutdown();
  expect(forced).toBe(true);
  expect(codes).toEqual([1]);
});

test("an email worker can drain after a synchronous job failure", async () => {
  let calls = 0;
  const stop = startEmailWorker(
    {} as DB,
    () => {
      calls++;
      if (calls === 1) throw new Error("injected worker failure");
      return Promise.resolve(false);
    },
    5,
  );
  try {
    for (let n = 0; n < 100 && calls < 2; n++) await Bun.sleep(5);
    await stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    await stop();
  }
});
