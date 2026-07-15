import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or } from "drizzle-orm";

import { db } from "../db";
import { clients } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import type { Variables } from "../types";

// All routes here are protected by authMiddleware, which sets c.get("userId").
// Every query below is scoped with eq(clients.userId, userId) so one user can't
// read or delete another user's clients just by guessing an ID (IDOR).

const clientsRouter = new Hono<{ Variables: Variables }>();

clientsRouter.use("*", authMiddleware);

const createClientSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please provide a valid email address"),
  companyName: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

// .partial() makes every field optional so updates can send just what changed
const updateClientSchema = createClientSchema.partial();

// GET /clients — all clients for the logged-in user, newest first, with
// optional ?search= filtering on name/email/company
clientsRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const search = c.req.query("search");

  const results = await db
    .select()
    .from(clients)
    .where(
      search
        ? and(
            eq(clients.userId, userId),
            or(
              ilike(clients.name, `%${search}%`),
              ilike(clients.email, `%${search}%`),
              ilike(clients.companyName, `%${search}%`),
            ),
          )
        : eq(clients.userId, userId),
    )
    .orderBy(desc(clients.createdAt));

  return c.json({ data: results });
});

// GET /clients/:id
clientsRouter.get("/:id", async (c) => {
  const userId = c.get("userId");
  const clientId = c.req.param("id");

  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.userId, userId)),
  });

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  return c.json({ data: client });
});

// POST /clients
clientsRouter.post("/", zValidator("json", createClientSchema), async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

  const [newClient] = await db
    .insert(clients)
    .values({
      id: crypto.randomUUID(),
      userId,
      name: body.name,
      email: body.email,
      companyName: body.companyName,
      phone: body.phone,
      address: body.address,
    })
    .returning();

  return c.json(
    { data: newClient, message: "Client created successfully" },
    201,
  );
});

// PUT /clients/:id
clientsRouter.put("/:id", zValidator("json", updateClientSchema), async (c) => {
  const userId = c.get("userId");
  const clientId = c.req.param("id");
  const body = c.req.valid("json");

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
      updatedAt: new Date(),
    })
    .where(and(eq(clients.id, clientId), eq(clients.userId, userId)))
    .returning();

  return c.json({ data: updated, message: "Client updated successfully" });
});

// DELETE /clients/:id — cascade delete in the schema takes care of the
// client's invoices too
clientsRouter.delete("/:id", async (c) => {
  const userId = c.get("userId");
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
