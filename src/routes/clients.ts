import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or } from "drizzle-orm";

import { db } from "../db";
import { clients } from "../db/schema";
import { authMiddleware } from "../middleware/auth";

/**
 * CLIENTS ROUTER
 *
 * All routes here are protected — authMiddleware runs first on every request.
 * It reads the access_token cookie, verifies the JWT, and injects c.get("userId")
 * so every handler below knows exactly which user is making the request.
 *
 * The key security pattern you'll see repeated everywhere:
 *   and(eq(clients.id, id), eq(clients.userId, userId))
 *
 * This means: "find the record where BOTH the id matches AND it belongs to this user."
 * Without the userId check, a user could read or delete another user's clients just
 * by guessing an ID. This is called an Insecure Direct Object Reference (IDOR) bug —
 * we prevent it by always scoping DB queries to the logged-in user.
 */

const clientsRouter = new Hono();

// Apply auth middleware to ALL routes in this file at once
clientsRouter.use("*", authMiddleware);

// ─── Zod Validation Schemas ───────────────────────────────────────────────────
// Zod lets us define the exact shape and rules for request data.
// @hono/zod-validator runs this before the handler — invalid requests never
// reach your business logic.

const createClientSchema = z.object({
  name:        z.string().min(2, "Name must be at least 2 characters"),
  email:       z.string().email("Please provide a valid email address"),
  companyName: z.string().optional(),
  phone:       z.string().optional(),
  address:     z.string().optional(),
});

// For updates we use .partial() — every field becomes optional so the client
// can send only the fields they want to change
const updateClientSchema = createClientSchema.partial();

// ─── GET /clients ─────────────────────────────────────────────────────────────
// Returns all clients for the logged-in user, newest first.
// Supports optional ?search= query param to filter by name, email, or company.

clientsRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const search = c.req.query("search");

  // Drizzle ORM's query builder — this generates:
  // SELECT * FROM clients WHERE user_id = $1 [AND (...)] ORDER BY created_at DESC
  const results = await db
    .select()
    .from(clients)
    .where(
      search
        ? and(
            eq(clients.userId, userId),
            or(
              ilike(clients.name,        `%${search}%`), // case-insensitive LIKE
              ilike(clients.email,       `%${search}%`),
              ilike(clients.companyName, `%${search}%`)
            )
          )
        : eq(clients.userId, userId)
    )
    .orderBy(desc(clients.createdAt));

  return c.json({ data: results });
});

// ─── GET /clients/:id ─────────────────────────────────────────────────────────
// Returns a single client. Returns 404 if not found or doesn't belong to user.

clientsRouter.get("/:id", async (c) => {
  const userId   = c.get("userId");
  const clientId = c.req.param("id");

  const client = await db.query.clients.findFirst({
    where: and(
      eq(clients.id,     clientId),
      eq(clients.userId, userId)
    ),
  });

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  return c.json({ data: client });
});

// ─── POST /clients ────────────────────────────────────────────────────────────
// Creates a new client. zValidator runs first and validates the request body.
// If validation fails, Hono automatically returns a 400 with the error details.

clientsRouter.post(
  "/",
  zValidator("json", createClientSchema),
  async (c) => {
    const userId = c.get("userId");
    const body   = c.req.valid("json"); // type-safe — TypeScript knows the shape

    const [newClient] = await db
      .insert(clients)
      .values({
        id:          crypto.randomUUID(),
        userId,
        name:        body.name,
        email:       body.email,
        companyName: body.companyName,
        phone:       body.phone,
        address:     body.address,
      })
      .returning(); // .returning() tells PostgreSQL to send back the inserted row

    return c.json({ data: newClient, message: "Client created successfully" }, 201);
  }
);

// ─── PUT /clients/:id ─────────────────────────────────────────────────────────
// Updates an existing client. Only updates the fields that are provided.

clientsRouter.put(
  "/:id",
  zValidator("json", updateClientSchema),
  async (c) => {
    const userId   = c.get("userId");
    const clientId = c.req.param("id");
    const body     = c.req.valid("json");

    // First check the client exists and belongs to this user
    const existing = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.userId, userId)),
    });

    if (!existing) {
      return c.json({ error: "Client not found" }, 404);
    }

    const [updated] = await db
      .update(clients)
      .set({
        ...body,
        updatedAt: new Date(), // always bump updatedAt on changes
      })
      .where(and(eq(clients.id, clientId), eq(clients.userId, userId)))
      .returning();

    return c.json({ data: updated, message: "Client updated successfully" });
  }
);

// ─── DELETE /clients/:id ──────────────────────────────────────────────────────
// Deletes a client. Because we set onDelete: "cascade" in the schema,
// PostgreSQL will automatically delete all invoices belonging to this client too.

clientsRouter.delete("/:id", async (c) => {
  const userId   = c.get("userId");
  const clientId = c.req.param("id");

  const existing = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.userId, userId)),
  });

  if (!existing) {
    return c.json({ error: "Client not found" }, 404);
  }

  await db
    .delete(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, userId)));

  return c.json({ message: "Client deleted successfully" });
});

export default clientsRouter;
