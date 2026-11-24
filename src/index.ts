import { configuration } from "./configuration";
import { flushMonitoring } from "./instrumentation";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logEvent, reportError, requestLogging } from "./lib/observability";
import { prettyJSON } from "hono/pretty-json";
import { HTTPException } from "hono/http-exception";
import { db, closeDatabase } from "./db";
import { createDatabaseReadiness } from "./db/readiness";
import { createShutdown } from "./lib/shutdown";
import { generateInvoicePDF } from "./lib/pdf";
import { startEmailWorker } from "./lib/email-queue";
import { createCsrfProtection } from "./middleware/csrf";
import { createRequestLimits } from "./middleware/request-limits";
import { createAuthRateLimit } from "./middleware/rate-limit";

import { createHealthRouter } from "./routes/health";
import auth from "./routes/auth";
import clients from "./routes/clients";
import invoices from "./routes/invoices";
import webhooks from "./routes/webhooks";
import payouts from "./routes/payouts";

const app = new Hono();
app.use("*", requestLogging());

app.use(
  "*",
  cors({
    origin: configuration.frontend,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    exposeHeaders: ["Retry-After", "X-Request-ID"],
  }),
);
app.use("*", async (c, next) => {
  if (lifecycle.isDraining() && c.req.path.replace(/\/$/, "") !== "/health") {
    c.header("Retry-After", "5");
    c.header("Cache-Control", "no-store");
    return c.json(
      { error: "Service is restarting. Please try again shortly" },
      503,
    );
  }
  await next();
});
app.use("*", prettyJSON());
app.use("*", createCsrfProtection(configuration.frontend));
app.use("*", createRequestLimits());
app.use("*", createAuthRateLimit(db));

const readiness = createDatabaseReadiness(process.env.DATABASE_URL!);
app.route(
  "/health",
  createHealthRouter(readiness.ready, () => lifecycle.isDraining()),
);
app.route("/auth", auth);
app.route("/clients", clients);
app.route("/invoices", invoices);
app.route("/webhooks", webhooks);
app.route("/payouts", payouts);

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

const server = Bun.serve({
  port: configuration.port,
  idleTimeout: 30,
  fetch: app.fetch,
});
let stopEmailWorker: () => Promise<void> = async () => {};
if (
  process.env.NODE_ENV !== "test" &&
  process.env.RESEND_API_KEY &&
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY
)
  stopEmailWorker = startEmailWorker(db);
const lifecycle = createShutdown({
  server,
  stopEmailWorker,
  closeReadiness: readiness.close,
  stopPdf: generateInvoicePDF.shutdown,
  closeDatabase,
  flushMonitoring,
  exit: (code) => process.exit(code),
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    void lifecycle.shutdown();
  });
logEvent("api.started");

export { app, server, lifecycle };
