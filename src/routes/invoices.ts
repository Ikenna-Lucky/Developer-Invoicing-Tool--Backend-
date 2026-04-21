import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or, sql } from "drizzle-orm";

import { db } from "../db";
import { invoices, invoiceItems, clients } from "../db/schema";
import { authMiddleware } from "../middleware/auth";

const invoicesRouter = new Hono();

invoicesRouter.use("*", authMiddleware);

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be positive"),
  rate: z.number().positive("Rate must be positive"),
});

const createInvoiceSchema = z.object({
  clientId: z.string().uuid("Invalid client ID"),
  issueDate: z.string().datetime({ message: "Invalid issue date" }),
  dueDate: z.string().datetime({ message: "Invalid due date" }),
  notes: z.string().optional(),
  items: z.array(lineItemSchema).min(1, "At least one line item is required"),
});

const updateInvoiceSchema = z.object({
  clientId: z.string().uuid().optional(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  items: z.array(lineItemSchema).min(1).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["draft", "sent", "paid", "overdue"]),
});

// ─── Helper: Generate next invoice number ─────────────────────────────────────
// Finds the highest existing invoice number for this user and increments it.
// Result format: INV-0001, INV-0002, ... INV-9999

async function generateInvoiceNumber(userId: string): Promise<string> {
  const existing = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.userId, userId))
    .orderBy(desc(invoices.createdAt));

  if (existing.length === 0) {
    return "INV-0001";
  }

  // Extract the numeric part from the last invoice number (e.g. "INV-0042" → 42)
  const numbers = existing
    .map((inv) => parseInt(inv.invoiceNumber.replace("INV-", ""), 10))
    .filter((n) => !isNaN(n));

  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return `INV-${String(max + 1).padStart(4, "0")}`;
}

// ─── Helper: Calculate total from items ───────────────────────────────────────

function calculateTotal(items: z.infer<typeof lineItemSchema>[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
}

// ─── GET /invoices ────────────────────────────────────────────────────────────
// Returns all invoices for the logged-in user with client info.
// Supports ?status= filter and ?search= (matches invoice number or client name).

invoicesRouter.get("/", async (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status") as
    | "draft"
    | "sent"
    | "paid"
    | "overdue"
    | undefined;
  const search = c.req.query("search");

  // Fetch invoices + join client name in one query using Drizzle's relational API
  const results = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      totalAmount: invoices.totalAmount,
      notes: invoices.notes,
      pdfUrl: invoices.pdfUrl,
      stripePaymentLink: invoices.stripePaymentLink,
      createdAt: invoices.createdAt,
      updatedAt: invoices.updatedAt,
      clientId: invoices.clientId,
      clientName: clients.name,
      clientEmail: clients.email,
      clientCompany: clients.companyName,
    })
    .from(invoices)
    .leftJoin(clients, eq(invoices.clientId, clients.id))
    .where(
      and(
        eq(invoices.userId, userId),
        status ? eq(invoices.status, status) : undefined,
        search
          ? or(
              ilike(invoices.invoiceNumber, `%${search}%`),
              ilike(clients.name, `%${search}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(invoices.createdAt));

  return c.json({ data: results });
});

// ─── GET /invoices/:id ────────────────────────────────────────────────────────
// Returns a single invoice with its line items and full client info.

invoicesRouter.get("/:id", async (c) => {
  const userId = c.get("userId");
  const invoiceId = c.req.param("id");

  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    with: {
      items: true,
      client: true,
    },
  });

  if (!invoice) {
    return c.json({ error: "Invoice not found" }, 404);
  }

  return c.json({ data: invoice });
});

// ─── POST /invoices ───────────────────────────────────────────────────────────
// Creates a new invoice along with its line items in a transaction.

invoicesRouter.post("/", zValidator("json", createInvoiceSchema), async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");

  // Verify the client belongs to this user
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, body.clientId), eq(clients.userId, userId)),
  });

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const invoiceNumber = await generateInvoiceNumber(userId);
  const totalAmount = calculateTotal(body.items);
  const invoiceId = crypto.randomUUID();

  // Use a transaction so the invoice and its items are always created together.
  // If any part fails, everything rolls back — no orphaned invoices.
  await db.transaction(async (tx) => {
    await tx.insert(invoices).values({
      id: invoiceId,
      userId,
      clientId: body.clientId,
      invoiceNumber,
      status: "draft",
      issueDate: new Date(body.issueDate),
      dueDate: new Date(body.dueDate),
      totalAmount: totalAmount.toFixed(2),
      notes: body.notes,
    });

    await tx.insert(invoiceItems).values(
      body.items.map((item) => ({
        id: crypto.randomUUID(),
        invoiceId,
        description: item.description,
        quantity: item.quantity.toString(),
        rate: item.rate.toString(),
        amount: (item.quantity * item.rate).toFixed(2),
      })),
    );
  });

  // Return the full invoice with items and client
  const created = await db.query.invoices.findFirst({
    where: eq(invoices.id, invoiceId),
    with: { items: true, client: true },
  });

  return c.json(
    { data: created, message: "Invoice created successfully" },
    201,
  );
});

// ─── PUT /invoices/:id ────────────────────────────────────────────────────────
// Updates an existing invoice. If items are provided, old items are replaced.

invoicesRouter.put(
  "/:id",
  zValidator("json", updateInvoiceSchema),
  async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    });

    if (!existing) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    // If client is being changed, verify it belongs to this user
    if (body.clientId) {
      const client = await db.query.clients.findFirst({
        where: and(eq(clients.id, body.clientId), eq(clients.userId, userId)),
      });
      if (!client) return c.json({ error: "Client not found" }, 404);
    }

    await db.transaction(async (tx) => {
      const newTotal = body.items ? calculateTotal(body.items) : undefined;

      await tx
        .update(invoices)
        .set({
          ...(body.clientId && { clientId: body.clientId }),
          ...(body.issueDate && { issueDate: new Date(body.issueDate) }),
          ...(body.dueDate && { dueDate: new Date(body.dueDate) }),
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(newTotal !== undefined && { totalAmount: newTotal.toFixed(2) }),
          updatedAt: new Date(),
        })
        .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

      // Replace items if provided
      if (body.items) {
        await tx
          .delete(invoiceItems)
          .where(eq(invoiceItems.invoiceId, invoiceId));
        await tx.insert(invoiceItems).values(
          body.items.map((item) => ({
            id: crypto.randomUUID(),
            invoiceId,
            description: item.description,
            quantity: item.quantity.toString(),
            rate: item.rate.toString(),
            amount: (item.quantity * item.rate).toFixed(2),
          })),
        );
      }
    });

    const updated = await db.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      with: { items: true, client: true },
    });

    return c.json({ data: updated, message: "Invoice updated successfully" });
  },
);

// ─── PATCH /invoices/:id/status ───────────────────────────────────────────────
// Updates only the status of an invoice. Used for draft→sent, sent→paid, etc.

invoicesRouter.patch(
  "/:id/status",
  zValidator("json", updateStatusSchema),
  async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");
    const { status } = c.req.valid("json");

    const existing = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    });

    if (!existing) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    const [updated] = await db
      .update(invoices)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)))
      .returning();

    return c.json({ data: updated, message: `Invoice marked as ${status}` });
  },
);

// ─── DELETE /invoices/:id ─────────────────────────────────────────────────────
// Deletes an invoice. Invoice items are cascade-deleted by the DB.

invoicesRouter.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const invoiceId = c.req.param("id");

  const existing = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
  });

  if (!existing) {
    return c.json({ error: "Invoice not found" }, 404);
  }

  await db
    .delete(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

  return c.json({ message: "Invoice deleted successfully" });
});

export default invoicesRouter;
