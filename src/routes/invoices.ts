import {
  listQuery,
  listPage,
  beforeCursor,
  cursorTime,
  searchPattern,
} from "../lib/pagination";
import { reportError } from "../lib/observability";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or, isNull, isNotNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "../db";
import {
  createDraftInvoice,
  updateDraftInvoice,
  changeInvoiceStatus,
  permanentlyDeleteDraftInvoice,
  lockOwnedInvoice,
} from "../lib/invoices";
import {
  invoices,
  invoiceItems,
  clients,
  users,
  emailJobs,
} from "../db/schema";
import { createAuthMiddleware } from "../middleware/auth";
import { generateInvoicePDF } from "../lib/pdf";
import { escapeEmailHtml } from "../lib/email";
import { enqueueEmail } from "../lib/email-queue";
import { consumeRateLimit } from "../middleware/rate-limit";
import type { Variables } from "../types";

export function createInvoicesRouter(
  database: DB = defaultDb,
  renderPdf = generateInvoicePDF,
) {
  const db = database;
  const invoicesRouter = new Hono<{ Variables: Variables }>();

  invoicesRouter.use("*", createAuthMiddleware(database, true));

  const lineItemSchema = z.object({
    description: z.string().min(1, "Description is required").max(500),
    quantity: z
      .number()
      .positive("Quantity must be positive")
      .max(99_999_999.99)
      .multipleOf(0.01),
    rate: z
      .number()
      .positive("Rate must be positive")
      .max(99_999_999.99)
      .multipleOf(0.01),
  });

  const createInvoiceSchema = z.object({
    clientId: z.string().uuid("Invalid client ID"),
    issueDate: z.string().datetime({ message: "Invalid issue date" }),
    dueDate: z.string().datetime({ message: "Invalid due date" }),
    notes: z.string().max(5000).optional(),
    items: z
      .array(lineItemSchema)
      .min(1, "At least one line item is required")
      .max(100),
  });

  const updateInvoiceSchema = z.object({
    clientId: z.string().uuid().optional(),
    issueDate: z.string().datetime().optional(),
    dueDate: z.string().datetime().optional(),
    notes: z.string().max(5000).optional(),
    items: z.array(lineItemSchema).min(1).max(100).optional(),
  });

  const updateStatusSchema = z.object({
    status: z.enum(["draft", "sent", "paid", "overdue"]),
  });

  invoicesRouter.get("/", async (c) => {
    const userId = c.get("userId");
    const query = listQuery(c.req.url, true);
    const { search, status } = query;

    const results = await db
      .select({
        id: invoices.id,
        cursorTime: cursorTime(invoices.createdAt),
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
          isNull(invoices.deletedAt),
          beforeCursor(invoices.createdAt, invoices.id, query.cursor),
          status ? eq(invoices.status, status) : undefined,
          query.clientId ? eq(invoices.clientId, query.clientId) : undefined,
          search
            ? or(
                ilike(invoices.invoiceNumber, searchPattern(search)),
                ilike(clients.name, searchPattern(search)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(query.limit + 1);

    return c.json(listPage(results, query.limit));
  });

  // GET /invoices/trash — soft-deleted invoices. Has to come before GET /:id
  // or "trash" gets matched as an invoice ID.
  invoicesRouter.get("/trash", async (c) => {
    const userId = c.get("userId");
    const query = listQuery(c.req.url, true);
    const { search, status } = query;

    const results = await db
      .select({
        id: invoices.id,
        cursorTime: cursorTime(invoices.deletedAt),
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalAmount: invoices.totalAmount,
        deletedAt: invoices.deletedAt,
        clientId: invoices.clientId,
        clientName: clients.name,
        clientEmail: clients.email,
      })
      .from(invoices)
      .leftJoin(clients, eq(invoices.clientId, clients.id))
      .where(
        and(
          eq(invoices.userId, userId),
          isNotNull(invoices.deletedAt),
          beforeCursor(invoices.deletedAt, invoices.id, query.cursor),
          status ? eq(invoices.status, status) : undefined,
          query.clientId ? eq(invoices.clientId, query.clientId) : undefined,
          search
            ? or(
                ilike(invoices.invoiceNumber, searchPattern(search)),
                ilike(clients.name, searchPattern(search)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(invoices.deletedAt), desc(invoices.id))
      .limit(query.limit + 1);

    return c.json(listPage(results, query.limit));
  });

  // GET /invoices/:id — single invoice with line items and client
  invoicesRouter.get("/:id", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.userId, userId),
        isNull(invoices.deletedAt),
      ),
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

  // GET /invoices/:id/pdf — streams the invoice as a PDF download
  invoicesRouter.get("/:id/pdf", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.userId, userId),
        isNull(invoices.deletedAt),
      ),
      with: { items: true, client: true },
    });

    if (!invoice) return c.json({ error: "Invoice not found" }, 404);

    // needed for logo, business name, contact details on the PDF
    const sender = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!sender) return c.json({ error: "User not found" }, 404);

    try {
      const quota = await consumeRateLimit(db, `invoice-pdf:${userId}`, 10, 60);
      if (!quota.allowed) {
        c.header("Retry-After", String(quota.retryAfter));
        return c.json(
          { error: "Too many PDF requests. Please try again later" },
          429,
        );
      }
      const pdfBuffer = await renderPdf({ invoice, sender });

      const filename = `${invoice.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "invoice"}.pdf`;

      return c.body(new Uint8Array(pdfBuffer), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": pdfBuffer.length.toString(),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (err) {
      if (err instanceof HTTPException) {
        if (err.status === 503) c.header("Retry-After", "5");
        return c.json({ error: err.message }, err.status);
      }
      reportError("pdf.failed", err);
      return c.json({ error: "Failed to generate PDF" }, 500);
    }
  });

  // POST /invoices — creates the invoice and its line items in one transaction
  // so we never end up with an invoice that has no items or vice versa
  invoicesRouter.post(
    "/",
    zValidator("json", createInvoiceSchema),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");

      const created = await createDraftInvoice(db, userId, body);

      return c.json(
        { data: created, message: "Invoice created successfully" },
        201,
      );
    },
  );

  // PUT /invoices/:id — if items are provided, old items are replaced wholesale
  invoicesRouter.put(
    "/:id",
    zValidator("json", updateInvoiceSchema),
    async (c) => {
      const userId = c.get("userId");
      const invoiceId = c.req.param("id");
      const body = c.req.valid("json");

      const updated = await updateDraftInvoice(db, userId, invoiceId, body);

      return c.json({ data: updated, message: "Invoice updated successfully" });
    },
  );

  // Paid invoices are final; drafts must go through Send.
  invoicesRouter.patch(
    "/:id/status",
    zValidator("json", updateStatusSchema),
    async (c) => {
      const userId = c.get("userId");
      const invoiceId = c.req.param("id");
      const { status } = c.req.valid("json");

      const updated = await changeInvoiceStatus(db, userId, invoiceId, status);

      return c.json({ data: updated, message: `Invoice marked as ${status}` });
    },
  );

  // POST /invoices/:id/send — creates a payment link and starts email delivery.
  invoicesRouter.post("/:id/send", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    const delivery = await db.transaction(async (tx) => {
      await lockOwnedInvoice(tx, userId, invoiceId);
      const invoice = await tx.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.userId, userId),
          isNull(invoices.deletedAt),
        ),
        with: { client: true, items: true },
      });

      if (!invoice)
        throw new HTTPException(404, { message: "Invoice not found" });
      if (
        invoice.status !== "draft" ||
        invoice.stripePaymentLink ||
        (await tx.query.payments.findFirst({
          where: (table, { eq }) => eq(table.invoiceId, invoiceId),
        }))
      ) {
        throw new HTTPException(409, {
          message: "Only draft invoices can be sent",
        });
      }

      const user = await tx.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!user) throw new HTTPException(404, { message: "User not found" });

      // Send without a payment link if Paystack fails or takes longer than 8 seconds.
      let paymentLink: string | null = null;

      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (paystackKey) {
        const controller = new AbortController();
        const paystackTimeout = setTimeout(() => controller.abort(), 8_000);

        try {
          const amountInKobo = Math.round(Number(invoice.totalAmount) * 100); // 1 NGN = 100 kobo

          const paystackRes = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${paystackKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                email: invoice.client.email,
                amount: amountInKobo,
                reference: `BILLD-${crypto.randomUUID()}`,
                currency: "NGN",
                metadata: {
                  invoice_id: invoice.id,
                  invoice_number: invoice.invoiceNumber,
                  client_name: invoice.client.name,
                },
              }),
              signal: controller.signal,
            },
          );

          if (paystackRes.ok) {
            const paystackData = (await paystackRes.json()) as {
              status: boolean;
              data: { authorization_url: string; reference: string };
            };
            if (paystackData.status) {
              paymentLink = paystackData.data.authorization_url;
            }
          }
        } catch (err) {
          reportError("paystack.checkout_failed", err);
        } finally {
          clearTimeout(paystackTimeout);
        }
      }

      // Issuing the invoice and queueing its email must commit together.
      await tx
        .update(invoices)
        .set({
          status: "sent",
          ...(paymentLink && { stripePaymentLink: paymentLink }),
          updatedAt: new Date(),
        })
        .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

      const updated = await tx.query.invoices.findFirst({
        where: eq(invoices.id, invoiceId),
        with: { items: true, client: true },
      });

      const senderName = user.businessName ?? user.fullName;
      const email = await enqueueEmail(tx, {
        userId,
        invoiceId,
        purpose: "invoice",
        message: {
          to: invoice.client.email,
          subject: `Invoice ${invoice.invoiceNumber} from ${senderName} — ₦${Number(invoice.totalAmount).toLocaleString("en-NG")}`,
          html: buildInvoiceEmail({ invoice, senderName, paymentLink }),
        },
      });
      return { updated, email };
    });
    return c.json(
      {
        data: delivery.updated,
        email: delivery.email,
        message: "Invoice issued; email queued",
      },
      202,
    );
  });

  // POST /invoices/:id/resend — re-sends the email for a non-draft invoice
  // without touching its status, for when a client says they never got it
  invoicesRouter.post("/:id/resend", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");
    const email = await db.transaction(async (tx) => {
      await lockOwnedInvoice(tx, userId, invoiceId);
      const invoice = await tx.query.invoices.findFirst({
        where: and(
          eq(invoices.id, invoiceId),
          eq(invoices.userId, userId),
          isNull(invoices.deletedAt),
        ),
        with: { client: true, items: true },
      });

      if (!invoice)
        throw new HTTPException(404, { message: "Invoice not found" });
      if (invoice.status === "draft") {
        throw new HTTPException(400, {
          message: "Draft invoices must be sent first, not resent",
        });
      }
      const latest = await tx.query.emailJobs.findFirst({
        where: eq(emailJobs.invoiceId, invoiceId),
        orderBy: desc(emailJobs.createdAt),
      });
      if (
        latest &&
        latest.expiresAt > new Date() &&
        ["pending", "processing"].includes(latest.status)
      )
        return { id: latest.id, status: latest.status };
      if (latest && Date.now() - latest.createdAt.getTime() < 60_000)
        throw new HTTPException(429, {
          message: "Please wait one minute before resending this invoice",
        });
      const user = await tx.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!user) throw new HTTPException(404, { message: "User not found" });

      const senderName = user.businessName ?? user.fullName;
      const paymentLink = invoice.stripePaymentLink ?? null;

      return enqueueEmail(tx, {
        userId,
        invoiceId,
        purpose: "invoice",
        message: {
          to: invoice.client.email,
          subject: `Invoice ${invoice.invoiceNumber} from ${senderName} — ₦${Number(invoice.totalAmount).toLocaleString("en-NG")}`,
          html: buildInvoiceEmail({ invoice, senderName, paymentLink }),
        },
      });
    });
    return c.json({ email, message: "Invoice email queued" }, 202);
  });

  invoicesRouter.get("/:id/email-deliveries", async (c) => {
    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, c.req.param("id")),
        eq(invoices.userId, c.get("userId")),
      ),
    });
    if (!invoice)
      throw new HTTPException(404, { message: "Invoice not found" });
    const jobs = await db
      .select({
        id: emailJobs.id,
        status: emailJobs.status,
        attempts: emailJobs.attempts,
        acceptedAt: emailJobs.acceptedAt,
        createdAt: emailJobs.createdAt,
        lastError: emailJobs.lastError,
      })
      .from(emailJobs)
      .where(eq(emailJobs.invoiceId, invoice.id))
      .orderBy(desc(emailJobs.createdAt))
      .limit(20);
    return c.json({ data: jobs });
  });

  // DELETE /invoices/:id — moves the invoice to Trash until restored or permanently deleted.
  invoicesRouter.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    const existing = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.userId, userId),
        isNull(invoices.deletedAt),
      ),
    });

    if (!existing) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    await db
      .update(invoices)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

    return c.json({ message: "Invoice moved to Trash" });
  });

  // POST /invoices/:id/restore
  invoicesRouter.post("/:id/restore", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    const existing = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.userId, userId),
        isNotNull(invoices.deletedAt),
      ),
    });

    if (!existing) {
      return c.json({ error: "Invoice not found in Trash" }, 404);
    }

    await db
      .update(invoices)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

    return c.json({ message: "Invoice restored successfully" });
  });

  // DELETE /invoices/:id/permanent — irreversible, items cascade-delete via the DB
  invoicesRouter.delete("/:id/permanent", async (c) => {
    const userId = c.get("userId");
    const invoiceId = c.req.param("id");

    await permanentlyDeleteDraftInvoice(db, userId, invoiceId);

    return c.json({ message: "Invoice permanently deleted" });
  });

  return invoicesRouter;
}

// invoice email template
type InvoiceWithRelations = typeof invoices.$inferSelect & {
  client: typeof clients.$inferSelect;
  items: (typeof invoiceItems.$inferSelect)[];
};

function buildInvoiceEmail({
  invoice,
  senderName,
  paymentLink,
}: {
  invoice: InvoiceWithRelations;
  senderName: string;
  paymentLink: string | null;
}): string {
  senderName = escapeEmailHtml(senderName);
  invoice = {
    ...invoice,
    invoiceNumber: escapeEmailHtml(invoice.invoiceNumber),
    notes: invoice.notes ? escapeEmailHtml(invoice.notes) : null,
    client: {
      ...invoice.client,
      name: escapeEmailHtml(invoice.client.name),
      email: escapeEmailHtml(invoice.client.email),
      companyName: invoice.client.companyName
        ? escapeEmailHtml(invoice.client.companyName)
        : null,
    },
    items: invoice.items.map((item) => ({
      ...item,
      description: escapeEmailHtml(item.description),
    })),
  };
  if (paymentLink) {
    const url = new URL(paymentLink);
    paymentLink = url.protocol === "https:" ? escapeEmailHtml(url.href) : null;
  }
  const fmt = (n: number | string) =>
    `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

  const issueDate = new Date(invoice.issueDate).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dueDate = new Date(invoice.dueDate).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const itemRows = invoice.items
    .map(
      (item) => `
    <tr>
      <td class="col-desc">${item.description}</td>
      <td class="col-qty">${Number(item.quantity)}</td>
      <td class="col-rate">${fmt(item.rate)}</td>
      <td class="col-amt">${fmt(item.amount)}</td>
    </tr>
  `,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Invoice ${invoice.invoiceNumber}</title>
  <style>
    body { margin:0; padding:0; background:#0a0f1e; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .wrapper { max-width:600px; margin:0 auto; padding:32px 16px; }
    .card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; overflow:hidden; }
    .section { padding:24px 28px; border-bottom:1px solid #1e293b; }
    .section:last-child { border-bottom:none; }
    .label { font-size:11px; color:#475569; text-transform:uppercase; letter-spacing:0.1em; margin:0 0 5px; }
    .meta-table { width:100%; border-collapse:collapse; }
    .meta-left { vertical-align:top; }
    .meta-right { vertical-align:top; text-align:right; }
    .items-table { width:100%; border-collapse:collapse; }
    .items-table th { padding:10px 12px; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; background:#0a0f1e; }
    .items-table td { padding:11px 12px; font-size:13px; border-bottom:1px solid #1e293b; }
    .col-desc { text-align:left; color:#e2e8f0; }
    .col-qty  { text-align:right; color:#94a3b8; width:40px; }
    .col-rate { text-align:right; color:#94a3b8; width:110px; font-family:monospace; }
    .col-amt  { text-align:right; color:#e2e8f0; width:110px; font-family:monospace; font-weight:600; }
    .total-table { width:100%; border-collapse:collapse; }
    .total-label { font-size:17px; font-weight:700; color:#fff; }
    .total-amount { font-size:26px; font-weight:900; color:#fff; font-family:monospace; text-align:right; }
    .pay-wrap { text-align:center; margin:28px 0 8px; }
    .pay-btn { display:inline-block; background:linear-gradient(135deg,#2563eb,#7c3aed); color:#fff; font-size:16px; font-weight:700; text-decoration:none; padding:14px 36px; border-radius:12px; letter-spacing:0.01em; }
    .pay-link { font-size:12px; color:#64748b; text-align:center; margin:6px 0 0; word-break:break-all; }
    @media only screen and (max-width:480px) {
      .wrapper { padding:20px 10px !important; }
      .section { padding:18px 16px !important; }
      .meta-left, .meta-right { display:block !important; width:100% !important; text-align:left !important; padding-bottom:12px !important; }
      .col-qty, .col-rate, .th-qty, .th-rate { display:none !important; }
      .col-amt, .th-amt { width:auto !important; }
      .items-table th, .items-table td { padding:9px 8px !important; }
      .total-label { font-size:15px !important; }
      .total-amount { font-size:20px !important; }
      .pay-btn { display:block !important; padding:14px 16px !important; font-size:15px !important; }
    }
  </style>
</head>
<body>
  <div class="wrapper">

    <!-- header -->
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:28px;font-weight:900;letter-spacing:-0.02em;background:linear-gradient(135deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:#7c3aed;">Billd</div>
      <p style="color:#64748b;font-size:13px;margin:6px 0 0;">Invoice from <strong style="color:#94a3b8;">${senderName}</strong></p>
    </div>

    <div class="card">

      <div style="height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed,#ec4899);"></div>

      <!-- invoice meta -->
      <div class="section">
        <table class="meta-table">
          <tr>
            <td class="meta-left">
              <p class="label">Invoice</p>
              <p style="font-size:22px;font-weight:700;color:#fff;margin:0;font-family:monospace;">${invoice.invoiceNumber}</p>
            </td>
            <td class="meta-right">
              <p class="label">Issued</p>
              <p style="font-size:13px;color:#94a3b8;margin:0 0 10px;font-family:monospace;">${issueDate}</p>
              <p class="label">Due</p>
              <p style="font-size:13px;color:#f87171;margin:0;font-family:monospace;font-weight:600;">${dueDate}</p>
            </td>
          </tr>
        </table>
      </div>

      <!-- bill to -->
      <div class="section">
        <p class="label">Bill To</p>
        <p style="font-size:15px;font-weight:600;color:#e2e8f0;margin:0;">${invoice.client.name}</p>
        ${invoice.client.companyName ? `<p style="font-size:13px;color:#64748b;margin:3px 0 0;">${invoice.client.companyName}</p>` : ""}
        <p style="font-size:13px;color:#64748b;margin:3px 0 0;">${invoice.client.email}</p>
      </div>

      <!-- line items -->
      <div style="padding:0;">
        <table class="items-table">
          <thead>
            <tr style="background:#0a0f1e;">
              <th class="col-desc" style="text-align:left;">Description</th>
              <th class="col-qty th-qty">Qty</th>
              <th class="col-rate th-rate">Rate</th>
              <th class="col-amt th-amt">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>

      <!-- total -->
      <div class="section" style="border-top:1px solid #1e293b;border-bottom:none;">
        <table class="total-table">
          <tr>
            <td class="total-label">Total Due</td>
            <td class="total-amount">${fmt(invoice.totalAmount)}</td>
          </tr>
        </table>
      </div>

      ${
        invoice.notes
          ? `
      <!-- notes -->
      <div class="section" style="border-top:1px solid #1e293b;border-bottom:none;">
        <p class="label">Notes</p>
        <p style="font-size:13px;color:#64748b;margin:0;line-height:1.6;">${invoice.notes}</p>
      </div>`
          : ""
      }

    </div>

    <!-- pay button -->
    ${
      paymentLink
        ? `
    <div class="pay-wrap">
      <a href="${paymentLink}" class="pay-btn">Pay Now — ${fmt(invoice.totalAmount)}</a>
    </div>
    <p class="pay-link">Or copy this link: <a href="${paymentLink}" style="color:#60a5fa;">${paymentLink}</a></p>`
        : ""
    }

    <!-- footer -->
    <p style="text-align:center;color:#334155;font-size:11px;margin-top:28px;">
      Sent via <strong>Billd</strong> — Professional invoicing for freelancers
    </p>

  </div>
</body>
</html>`;
}

export default createInvoicesRouter();
