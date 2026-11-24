import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import postgres from "postgres";
import { createTestDatabase } from "./database";
import { createDatabaseReadiness } from "../../src/db/readiness";

const context = createTestDatabase();
let url: URL;
beforeAll(async () => {
  await context.create();
  const [{ name }] = await context.client`SELECT current_database() AS name`;
  url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
});
afterAll(() => context.close());

test("readiness uses a separate connection and does not cancel occupied business connections", async () => {
  const business = postgres(url.toString(), { max: 1 });
  const reserved = await business.reserve();
  const probe = createDatabaseReadiness(url.toString(), {
    ssl: false,
    cacheMs: 0,
  });
  try {
    const transaction = reserved`SELECT pg_sleep(0.2), 42 AS value`;
    const [rows, ready] = await Promise.all([transaction, probe.ready()]);
    expect(ready).toBe(true);
    expect(rows[0].value).toBe(42);
    await probe.close();
    expect(await probe.ready()).toBe(false);
    expect((await reserved`SELECT 43 AS value`)[0].value).toBe(43);
  } finally {
    reserved.release();
    await business.end();
    await probe.close();
  }
});

test("readiness fails safely on a database outage and recovers on a later probe", async () => {
  const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  const probe = createDatabaseReadiness(url.toString(), {
    ssl: false,
    cacheMs: 0,
  });
  const name = decodeURIComponent(url.pathname.slice(1));
  try {
    expect(await probe.ready()).toBe(true);
    await admin.unsafe(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
    expect(await probe.ready()).toBe(false);
    await admin.unsafe(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`);
    expect(await probe.ready()).toBe(true);
  } finally {
    await admin.unsafe(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS true`);
    await probe.close();
    await admin.end();
  }
});

test("an unresponsive database has a bounded, shared probe and cached failures", async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const probe = createDatabaseReadiness(
    `postgresql://dummy:dummy@127.0.0.1:${address.port}/unused`,
    { ssl: false, timeoutMs: 75, cacheMs: 1000 },
  );
  try {
    const started = performance.now();
    const pending = probe.ready();
    expect(probe.ready()).toBe(pending);
    expect(await pending).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await probe.ready()).toBe(false);
    expect(connections).toBe(1);
  } finally {
    await probe.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
