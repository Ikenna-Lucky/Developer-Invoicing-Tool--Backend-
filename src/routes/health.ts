import { Hono } from "hono";
import { db } from "../db";
import { sql } from "drizzle-orm";

const health = new Hono();

// GET /health — basic liveness check
health.get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "developer-invoicing-api",
  });
});

// GET /health/db — checks that the database connection is alive
health.get("/db", async (c) => {
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json(
      {
        status: "error",
        database: "disconnected",
        message: "Could not reach the database",
      },
      500
    );
  }
});

export default health;
