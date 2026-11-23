import { createMiddleware } from "hono/factory";
import { applicationOrigin } from "../lib/configuration";

export function frontendOrigin(
  value = process.env.FRONTEND_URL ?? "http://localhost:3000",
) {
  return applicationOrigin(
    "FRONTEND_URL",
    value,
    process.env.NODE_ENV === "production",
  );
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
