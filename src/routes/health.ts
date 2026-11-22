import { Hono } from "hono";

export function createHealthRouter(
  checkDatabase: () => Promise<boolean>,
  isDraining: () => boolean,
) {
  const health = new Hono();
  health.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  health.get("/", (c) =>
    c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "developer-invoicing-api",
    }),
  );
  health.get("/ready", async (c) => {
    const ready =
      !isDraining() &&
      (await checkDatabase().catch(() => false)) &&
      !isDraining();
    return c.json(
      { status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });
  // Keep the legacy diagnostic response; Render should use /health/ready.
  health.get("/db", async (c) => {
    const ready =
      !isDraining() &&
      (await checkDatabase().catch(() => false)) &&
      !isDraining();
    return ready
      ? c.json({
          status: "ok",
          database: "connected",
          timestamp: new Date().toISOString(),
        })
      : c.json(
          {
            status: "error",
            database: "disconnected",
            message: "Could not reach the database",
          },
          500,
        );
  });
  return health;
}
