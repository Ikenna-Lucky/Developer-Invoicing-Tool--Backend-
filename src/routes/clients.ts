import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or, getTableColumns } from "drizzle-orm";
import {
  listQuery,
  listPage,
  beforeCursor,
  cursorTime,
  searchPattern,
} from "../lib/pagination";

import { db as defaultDb, type DB } from "../db";
import { deleteClientWithoutInvoices } from "../lib/invoices";
import { clients } from "../db/schema";
import { createAuthMiddleware } from "../middleware/auth";
import type { Variables } from "../types";

// Keep every client query scoped to the signed-in user.

export function createClientsRouter(database: DB = defaultDb) {
  const db = database;
  const clientsRouter = new Hono<{ Variables: Variables }>();

  clientsRouter.use("*", createAuthMiddleware(database, true));

  const createClientSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters").max(200),
    email: z.string().email("Please provide a valid email address").max(254),
    companyName: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
    address: z.string().max(2000).optional(),
  });

  // .partial() makes every field optional so updates can send just what changed
  const updateClientSchema = createClientSchema.partial();

  // Keep the ID tie-breaker when several clients share a creation timestamp.
  clientsRouter.get("/", async (c) => {
    const userId = c.get("userId");
    const query = listQuery(c.req.url);
    const { search } = query;

    const results = await db
      .select({
        ...getTableColumns(clients),
        cursorTime: cursorTime(clients.createdAt),
      })
      .from(clients)
      .where(
        and(
          eq(clients.userId, userId),
          beforeCursor(clients.createdAt, clients.id, query.cursor),
          search
            ? or(
                ilike(clients.name, searchPattern(search)),
                ilike(clients.email, searchPattern(search)),
                ilike(clients.companyName, searchPattern(search)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(clients.createdAt), desc(clients.id))
      .limit(query.limit + 1);

    return c.json(listPage(results, query.limit));
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
  clientsRouter.put(
    "/:id",
    zValidator("json", updateClientSchema),
    async (c) => {
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
    },
  );

  // Keep clients referenced by invoices, including drafts in Trash.
  clientsRouter.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const clientId = c.req.param("id");

    await deleteClientWithoutInvoices(db, userId, clientId);

    return c.json({ message: "Client deleted successfully" });
  });

  return clientsRouter;
}

export default createClientsRouter();
