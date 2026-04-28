import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { HTTPException } from "hono/http-exception";

import health from "./routes/health";
import auth from "./routes/auth";
import clients from "./routes/clients";
import invoices from "./routes/invoices";
import webhooks from "./routes/webhooks";

// --- App Setup ---
const app = new Hono();

// --- Global Middleware ---
app.use(
  "*",
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);
app.use("*", logger());
app.use("*", prettyJSON());

// --- Routes ---
app.route("/health", health);
app.route("/auth", auth);
app.route("/clients", clients);
app.route("/invoices", invoices);
app.route("/webhooks", webhooks);

// --- Root ---
app.get("/", (c) => {
  return c.json({
    message: "Developer Invoicing API",
    version: "1.0.0",
    docs: "/health",
  });
});

// --- Global Error Handler ---
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

// --- 404 Handler ---
app.notFound((c) => {
  return c.json({ error: `Route ${c.req.path} not found` }, 404);
});

// --- Start Server ---
const port = parseInt(process.env.PORT ?? "3001");
console.log(`🚀 API running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
