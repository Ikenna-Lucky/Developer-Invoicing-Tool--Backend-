import { createMiddleware } from "hono/factory";

export function frontendOrigin(
  value = process.env.FRONTEND_URL ?? "http://localhost:3000",
) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "FRONTEND_URL must be an HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

export function createCsrfProtection(origin = frontendOrigin()) {
  return createMiddleware(async (c, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.path !== "/webhooks/paystack"
    ) {
      // CORS alone does not stop a browser from submitting a cross-site form.
      if (c.req.header("Origin") !== origin) {
        return c.json({ error: "Request origin is not allowed" }, 403);
      }
    }
    await next();
  });
}
