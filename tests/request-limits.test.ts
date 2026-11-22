import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  boundedBody,
  createRequestLimits,
} from "../src/middleware/request-limits";

test("request budgets count streamed bytes even when Content-Length is absent or false", async () => {
  for (const length of [undefined, "1"]) {
    let reached = false;
    const app = new Hono();
    app.use("*", boundedBody(8));
    app.post("/", (c) => {
      reached = true;
      return c.text("unexpected");
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    const request = new Request("http://localhost/", {
      method: "POST",
      body: stream,
      headers: length ? { "Content-Length": length } : {},
    });
    expect((await app.request(request)).status).toBe(413);
    expect(reached).toBe(false);
  }
});

test("each API body budget accepts its boundary, preserves bytes, and rejects the next byte", async () => {
  const app = new Hono();
  app.use("*", createRequestLimits());
  app.all("*", async (c) => c.body(await c.req.arrayBuffer()));
  for (const [path, size] of [
    ["/clients", 16 * 1024],
    ["/invoices/123", 128 * 1024],
    ["/auth/me", 768 * 1024],
    ["/webhooks/paystack", 256 * 1024],
  ] as const) {
    const bytes = new Uint8Array(size).fill(200);
    const response = await app.request(path, { method: "POST", body: bytes });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(
      (
        await app.request(path, {
          method: "POST",
          body: new Uint8Array(size + 1),
        })
      ).status,
    ).toBe(413);
  }
});

test("read failures return 400 and oversized URLs return 414 before handlers", async () => {
  const app = new Hono();
  app.use("*", createRequestLimits());
  app.all("*", (c) => c.text("unexpected"));
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error("broken body"));
    },
  });
  expect(
    (
      await app.request(
        new Request("http://localhost/clients", {
          method: "POST",
          body: stream,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await app.request(`/clients?search=${"a".repeat(8192)}`)).status,
  ).toBe(414);
});
