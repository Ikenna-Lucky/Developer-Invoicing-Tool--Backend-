import "./instrumentation";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logEvent, reportError, requestLogging } from "./lib/observability";
import { prettyJSON } from "hono/pretty-json";
import { HTTPException } from "hono/http-exception";
import { validateAuthConfiguration } from "./lib/jwt";
import { db } from "./db";
import { emailQueueKey, startEmailWorker } from "./lib/email-queue";
import { createCsrfProtection, frontendOrigin } from "./middleware/csrf";
import { createRequestLimits } from "./middleware/request-limits";
import { createAuthRateLimit } from "./middleware/rate-limit";

import health from "./routes/health";
import auth from "./routes/auth";
import clients from "./routes/clients";
import invoices from "./routes/invoices";
import webhooks from "./routes/webhooks";

validateAuthConfiguration();
const app = new Hono();
app.use("*", requestLogging());

app.use(
  "*",
  cors({
    origin: frontendOrigin(),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    exposeHeaders: ["Retry-After", "X-Request-ID"],
  }),
);
app.use("*", prettyJSON());
app.use("*", createCsrfProtection());
app.use("*", createRequestLimits());
app.use("*", createAuthRateLimit(db));

app.route("/health", health);
app.route("/auth", auth);
app.route("/clients", clients);
app.route("/invoices", invoices);
app.route("/webhooks", webhooks);

app.get("/", (c) => {
  return c.json({
    message: "Developer Invoicing API",
    version: "1.0.0",
    docs: "/health",
  });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.status >= 500) reportError("request.failed", err);
    return c.json({ error: err.message }, err.status);
  }
  reportError("request.failed", err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => {
  return c.json({ error: "Route not found" }, 404);
});

const port = parseInt(process.env.PORT ?? "3001");
if (
  process.env.NODE_ENV === "production" ||
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY
)
  emailQueueKey();
if (process.env.NODE_ENV === "production" && !process.env.RESEND_API_KEY)
  throw new Error("RESEND_API_KEY is required in production");
if (
  process.env.NODE_ENV !== "test" &&
  process.env.RESEND_API_KEY &&
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY
)
  startEmailWorker(db);
logEvent("api.started");

export default {
  port,
  fetch: app.fetch,
};
