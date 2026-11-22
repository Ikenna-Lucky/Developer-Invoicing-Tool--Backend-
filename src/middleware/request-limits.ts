import { createMiddleware } from "hono/factory";

export function boundedBody(
  limit: number,
  message = "Request body is too large",
) {
  return createMiddleware(async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          void reader.cancel().catch(() => {});
          return c.json({ error: message }, 413);
        }
        chunks.push(value);
      }
    } catch {
      return c.json({ error: "Could not read the request body" }, 400);
    } finally {
      reader.releaseLock();
    }
    c.req.raw = new Request(c.req.raw, { body: Buffer.concat(chunks) });
    await next();
  });
}

export function createRequestLimits() {
  return createMiddleware(async (c, next) => {
    if (Buffer.byteLength(c.req.url, "utf8") > 8192)
      return c.json({ error: "Request URL is too long" }, 414);
    const path = c.req.path.replace(/\/$/, "");
    const bytes =
      path === "/auth/me"
        ? 768 * 1024
        : path === "/webhooks/paystack"
          ? 256 * 1024
          : path === "/invoices" || path.startsWith("/invoices/")
            ? 128 * 1024
            : 16 * 1024;
    return boundedBody(bytes)(c, next);
  });
}
