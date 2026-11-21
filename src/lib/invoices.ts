import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DB } from "../db";
import { clients, invoiceCounters, invoiceItems, invoices } from "../db/schema";

type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];
type LineItem = { description: string; quantity: number; rate: number };
type InvoiceInput = {
  clientId: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  items: LineItem[];
};

function hundredths(value: number): bigint {
  const [whole, fraction = ""] = value.toString().split(".");
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !/^\d+$/.test(whole) ||
    fraction.length > 2
  ) {
    throw new HTTPException(400, {
      message:
        "Quantity and rate must be positive with at most two decimal places",
    });
  }
  const scaled = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (scaled > 9_999_999_999n)
    throw new HTTPException(400, {
      message: "Quantity or rate exceeds 99999999.99",
    });
  return scaled;
}

function money(kobo: bigint): string {
  return `${kobo / 100n}.${String(kobo % 100n).padStart(2, "0")}`;
}

function priceItems(items: LineItem[]) {
  let total = 0n;
  const priced = items.map((item) => {
    // Round each line to a kobo before adding it to the invoice total.
    const amount =
      (hundredths(item.quantity) * hundredths(item.rate) + 50n) / 100n;
    total += amount;
    return { ...item, amount: money(amount) };
  });
  if (total <= 0n || total > 9_999_999_999n) {
    throw new HTTPException(400, {
      message: "Invoice total must be between 0.01 and 99999999.99",
    });
  }
  return { items: priced, totalAmount: money(total) };
}

export async function lockOwnedInvoice(
  tx: Transaction,
  userId: string,
  invoiceId: string,
  includeTrash = false,
) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.userId, userId),
        includeTrash ? undefined : isNull(invoices.deletedAt),
      ),
    )
    .for("update");
  if (!invoice) throw new HTTPException(404, { message: "Invoice not found" });
  return invoice;
}

async function requireDraft(
  tx: Transaction,
  invoice: typeof invoices.$inferSelect,
) {
  const payment = await tx.query.payments.findFirst({
    where: (table, { eq }) => eq(table.invoiceId, invoice.id),
  });
  if (invoice.status !== "draft" || invoice.stripePaymentLink || payment) {
    throw new HTTPException(409, {
      message:
        "Only unpaid drafts without a payment link can be edited or permanently deleted",
    });
  }
}

async function lockClient(tx: Transaction, userId: string, clientId: string) {
  const [client] = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.userId, userId)))
    .for("key share");
  if (!client) throw new HTTPException(404, { message: "Client not found" });
}

export async function createDraftInvoice(
  database: DB,
  userId: string,
  body: InvoiceInput,
) {
  const priced = priceItems(body.items);
  if (new Date(body.dueDate) < new Date(body.issueDate)) {
    throw new HTTPException(400, {
      message: "Due date cannot be before issue date",
    });
  }
  return database.transaction(async (tx) => {
    await lockClient(tx, userId, body.clientId);
    // The counter survives draft deletion and is incremented atomically per user.
    const [counter] = await tx
      .insert(invoiceCounters)
      .values({ userId, lastNumber: 1 })
      .onConflictDoUpdate({
        target: invoiceCounters.userId,
        set: { lastNumber: sql`${invoiceCounters.lastNumber} + 1` },
      })
      .returning();
    const invoiceId = crypto.randomUUID();
    await tx.insert(invoices).values({
      id: invoiceId,
      userId,
      clientId: body.clientId,
      invoiceNumber: `INV-${String(counter.lastNumber).padStart(4, "0")}`,
      issueDate: new Date(body.issueDate),
      dueDate: new Date(body.dueDate),
      totalAmount: priced.totalAmount,
      notes: body.notes,
    });
    await tx.insert(invoiceItems).values(
      priced.items.map((item) => ({
        id: crypto.randomUUID(),
        invoiceId,
        description: item.description,
        quantity: item.quantity.toString(),
        rate: item.rate.toString(),
        amount: item.amount,
      })),
    );
    return tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      with: { items: true, client: true },
    });
  });
}

export async function updateDraftInvoice(
  database: DB,
  userId: string,
  invoiceId: string,
  body: Partial<InvoiceInput>,
) {
  return database.transaction(async (tx) => {
    const invoice = await lockOwnedInvoice(tx, userId, invoiceId);
    await requireDraft(tx, invoice);
    if (body.clientId) await lockClient(tx, userId, body.clientId);
    const issueDate = body.issueDate
      ? new Date(body.issueDate)
      : invoice.issueDate;
    const dueDate = body.dueDate ? new Date(body.dueDate) : invoice.dueDate;
    if (dueDate < issueDate)
      throw new HTTPException(400, {
        message: "Due date cannot be before issue date",
      });
    const priced = body.items ? priceItems(body.items) : undefined;
    await tx
      .update(invoices)
      .set({
        clientId: body.clientId,
        issueDate,
        dueDate,
        notes: body.notes,
        totalAmount: priced?.totalAmount,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));
    if (priced) {
      await tx
        .delete(invoiceItems)
        .where(eq(invoiceItems.invoiceId, invoiceId));
      await tx.insert(invoiceItems).values(
        priced.items.map((item) => ({
          id: crypto.randomUUID(),
          invoiceId,
          description: item.description,
          quantity: item.quantity.toString(),
          rate: item.rate.toString(),
          amount: item.amount,
        })),
      );
    }
    return tx.query.invoices.findFirst({
      where: eq(invoices.id, invoiceId),
      with: { items: true, client: true },
    });
  });
}

export async function changeInvoiceStatus(
  database: DB,
  userId: string,
  invoiceId: string,
  status: typeof invoices.$inferSelect.status,
) {
  return database.transaction(async (tx) => {
    const invoice = await lockOwnedInvoice(tx, userId, invoiceId);
    if (invoice.status === status) return invoice;
    const allowed =
      (invoice.status === "sent" &&
        (status === "paid" || status === "overdue")) ||
      (invoice.status === "overdue" && status === "paid");
    if (!allowed)
      throw new HTTPException(409, {
        message: "Invoice status cannot change this way; use Send for a draft",
      });
    if (status === "overdue" && invoice.dueDate >= new Date()) {
      throw new HTTPException(409, { message: "Invoice is not overdue yet" });
    }
    const [updated] = await tx
      .update(invoices)
      .set({ status, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();
    return updated;
  });
}

export async function permanentlyDeleteDraftInvoice(
  database: DB,
  userId: string,
  invoiceId: string,
) {
  await database.transaction(async (tx) => {
    const invoice = await lockOwnedInvoice(tx, userId, invoiceId, true);
    if (!invoice.deletedAt)
      throw new HTTPException(404, { message: "Invoice not found in Trash" });
    await requireDraft(tx, invoice);
    await tx.delete(invoices).where(eq(invoices.id, invoiceId));
  });
}

export async function deleteClientWithoutInvoices(
  database: DB,
  userId: string,
  clientId: string,
) {
  await database.transaction(async (tx) => {
    const [client] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.userId, userId)))
      .for("update");
    if (!client) throw new HTTPException(404, { message: "Client not found" });
    const invoice = await tx.query.invoices.findFirst({
      where: eq(invoices.clientId, clientId),
    });
    if (invoice)
      throw new HTTPException(409, {
        message:
          "Clients with invoices cannot be deleted, including invoices in Trash",
      });
    await tx.delete(clients).where(eq(clients.id, clientId));
  });
}
