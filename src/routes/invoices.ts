import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc, ilike, or, sql, isNull, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { invoices, invoiceItems, clients, users } from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { generateInvoicePDF } from "../lib/pdf";
import { sendMail } from "../lib/email";
import type { Variables } from "../types";

const invoicesRouter = new Hono<{ Variables: Variables }>();

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
        isNull(invoices.deletedAt), // exclude soft-deleted
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

// ─── GET /invoices/trash ──────────────────────────────────────────────────────
// Returns all soft-deleted invoices for this user (Trash view).
// IMPORTANT: must be defined before GET /:id so "trash" isn't treated as an ID.

invoicesRouter.get("/trash", async (c) => {
  const userId = c.get("userId");

  const results = await db
    .select({
      id: invoices.id,
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
    .where(and(eq(invoices.userId, userId), isNotNull(invoices.deletedAt)))
    .orderBy(desc(invoices.deletedAt));

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

// ─── GET /invoices/:id/pdf ────────────────────────────────────────────────────
// Generates and streams a PDF of the invoice as a file download.

invoicesRouter.get("/:id/pdf", async (c) => {
  const userId = c.get("userId");
  const invoiceId = c.req.param("id");

  // Fetch invoice + relations
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    with: { items: true, client: true },
  });

  if (!invoice) return c.json({ error: "Invoice not found" }, 404);

  // Fetch sender info (needed for logo, business name, contact details)
  const sender = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!sender) return c.json({ error: "User not found" }, 404);

  try {
    const pdfBuffer = await generateInvoicePDF({ invoice, sender });

    const filename = `${invoice.invoiceNumber}.pdf`;

    return c.body(new Uint8Array(pdfBuffer), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdfBuffer.length.toString(),
    });
  } catch (err) {
    console.error("PDF generation error:", err);
    return c.json({ error: "Failed to generate PDF" }, 500);
  }
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

// ─── POST /invoices/:id/send ──────────────────────────────────────────────────
// Sends the invoice to the client via email.
// Creates a Paystack payment link, marks invoice as "sent", returns immediately,
// then fires the email in the background so Render's 90-second gateway can't
// cut off the response mid-flight.

invoicesRouter.post("/:id/send", async (c) => {
  const userId = c.get("userId");
  const invoiceId = c.req.param("id");

  // ── Fetch invoice + client ────────────────────────────────────────────────
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    with: { client: true, items: true },
  });

  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  if (invoice.status !== "draft") {
    return c.json({ error: "Only draft invoices can be sent" }, 400);
  }

  // ── Fetch sender (the logged-in freelancer) ───────────────────────────────
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return c.json({ error: "User not found" }, 404);

  // ── 1. Generate Paystack payment link ─────────────────────────────────────
  // Hard 8-second timeout so a slow/unresponsive Paystack API never hangs the
  // entire request. Non-fatal — we send the email without a link if it fails.
  let paymentLink: string | null = null;

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (paystackKey) {
    const controller = new AbortController();
    const paystackTimeout = setTimeout(() => controller.abort(), 8_000);

    try {
      // Paystack amounts are in kobo (1 NGN = 100 kobo)
      const amountInKobo = Math.round(Number(invoice.totalAmount) * 100);

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
            reference: `BILLD-${invoice.invoiceNumber}-${Date.now()}`,
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
      console.error("[send] Paystack error (non-fatal):", err);
    } finally {
      clearTimeout(paystackTimeout);
    }
  }

  // ── 2. Update invoice status + save payment link ──────────────────────────
  // Do this BEFORE returning the response so the DB is always consistent even
  // if the background email job fails. This also prevents the "double-send"
  // bug where the gateway timeout causes the client to retry and the second
  // request hits "Only draft invoices can be sent".
  await db
    .update(invoices)
    .set({
      status: "sent",
      ...(paymentLink && { stripePaymentLink: paymentLink }),
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));

  const updated = await db.query.invoices.findFirst({
    where: eq(invoices.id, invoiceId),
    with: { items: true, client: true },
  });

  // ── 3. Fire email in the background (non-blocking) ────────────────────────
  // We do NOT await this. The HTTP response is already on its way back to the
  // client. Bun keeps the process alive to finish this work even after the
  // response is flushed — email delivery happens out-of-band.
  //
  // We intentionally omit `from` here. email.ts defaults to the Resend sandbox
  // sender (onboarding@resend.dev). Once you verify a custom domain in Resend,
  // set RESEND_FROM="Billd <invoices@yourdomain.com>" and add it back here.
  const senderName = user.businessName ?? user.fullName;

  sendMail({
    to: invoice.client.email,
    subject: `Invoice ${invoice.invoiceNumber} from ${senderName} — ₦${Number(invoice.totalAmount).toLocaleString("en-NG")}`,
    html: buildInvoiceEmail({ invoice, senderName, paymentLink }),
  }).catch((err) => {
    console.error("[send] Background email failed:", err);
  });

  return c.json({ data: updated, message: "Invoice sent successfully" });
});

// ─── POST /invoices/:id/resend ────────────────────────────────────────────────
// Re-sends the invoice email for any non-draft invoice (sent, paid, overdue).
// Useful when the client claims they never received the original email.
// Does NOT change the invoice status — just fires the email again.

invoicesRouter.post("/:id/resend", async (c) => {
  const userId = c.get("userId");
  const invoiceId = c.req.param("id");

  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)),
    with: { client: true, items: true },
  });

  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  if (invoice.status === "draft") {
    return c.json(
      { error: "Draft invoices must be sent first, not resent" },
      400,
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return c.json({ error: "User not found" }, 404);

  const senderName = user.businessName ?? user.fullName;
  const paymentLink = invoice.stripePaymentLink ?? null;

  // Fire email in the background — same pattern as the send route
  sendMail({
    to: invoice.client.email,
    subject: `Invoice ${invoice.invoiceNumber} from ${senderName} — ₦${Number(invoice.totalAmount).toLocaleString("en-NG")}`,
    html: buildInvoiceEmail({ invoice, senderName, paymentLink }),
  }).catch((err) => {
    console.error("[resend] Background email failed:", err);
  });

  return c.json({ message: "Invoice resent successfully" });
});

// ─── Email builder ────────────────────────────────────────────────────────────

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
      <td style="padding:12px 16px;color:#e2e8f0;font-size:14px;border-bottom:1px solid #1e293b;">${item.description}</td>
      <td style="padding:12px 16px;color:#94a3b8;font-size:14px;text-align:right;border-bottom:1px solid #1e293b;">${Number(item.quantity)}</td>
      <td style="padding:12px 16px;color:#94a3b8;font-size:14px;text-align:right;border-bottom:1px solid #1e293b;font-family:monospace;">${fmt(item.rate)}</td>
      <td style="padding:12px 16px;color:#e2e8f0;font-size:14px;text-align:right;border-bottom:1px solid #1e293b;font-family:monospace;font-weight:600;">${fmt(item.amount)}</td>
    </tr>
  `,
    )
    .join("");

  const payButton = paymentLink
    ? `
    <div style="text-align:center;margin:32px 0;">
      <a href="${paymentLink}"
         style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:12px;letter-spacing:0.01em;">
        Pay Now — ${fmt(invoice.totalAmount)}
      </a>
    </div>
  `
    : "";

  const payLink = paymentLink
    ? `
    <p style="font-size:13px;color:#64748b;text-align:center;margin-top:8px;word-break:break-all;">
      Or copy this link: <a href="${paymentLink}" style="color:#60a5fa;">${paymentLink}</a>
    </p>
  `
    : "";

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
    /* Meta row — two-column table so it works in all email clients */
    .meta-table { width:100%; border-collapse:collapse; }
    .meta-left { vertical-align:top; }
    .meta-right { vertical-align:top; text-align:right; }
    /* Line items */
    .items-table { width:100%; border-collapse:collapse; }
    .items-table th { padding:10px 12px; color:#475569; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; background:#0a0f1e; }
    .items-table td { padding:11px 12px; font-size:13px; border-bottom:1px solid #1e293b; }
    .col-desc { text-align:left; color:#e2e8f0; }
    .col-qty  { text-align:right; color:#94a3b8; width:40px; }
    .col-rate { text-align:right; color:#94a3b8; width:110px; font-family:monospace; }
    .col-amt  { text-align:right; color:#e2e8f0; width:110px; font-family:monospace; font-weight:600; }
    /* Total row */
    .total-table { width:100%; border-collapse:collapse; }
    .total-label { font-size:17px; font-weight:700; color:#fff; }
    .total-amount { font-size:26px; font-weight:900; color:#fff; font-family:monospace; text-align:right; }
    /* Pay button */
    .pay-wrap { text-align:center; margin:28px 0 8px; }
    .pay-btn { display:inline-block; background:linear-gradient(135deg,#2563eb,#7c3aed); color:#fff; font-size:16px; font-weight:700; text-decoration:none; padding:14px 36px; border-radius:12px; letter-spacing:0.01em; }
    .pay-link { font-size:12px; color:#64748b; text-align:center; margin:6px 0 0; word-break:break-all; }
    /* Mobile overrides */
    @media only screen and (max-width:480px) {
      .wrapper { padding:20px 10px !important; }
      .section { padding:18px 16px !important; }
      /* Stack meta left/right vertically */
      .meta-left, .meta-right { display:block !important; width:100% !important; text-align:left !important; padding-bottom:12px !important; }
      /* Hide Qty & Rate columns — show Description + Amount only */
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

    <!-- Header -->
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:28px;font-weight:900;letter-spacing:-0.02em;background:linear-gradient(135deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:#7c3aed;">Billd</div>
      <p style="color:#64748b;font-size:13px;margin:6px 0 0;">Invoice from <strong style="color:#94a3b8;">${senderName}</strong></p>
    </div>

    <!-- Card -->
    <div class="card">

      <!-- Top gradient bar -->
      <div style="height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed,#ec4899);"></div>

      <!-- Invoice meta (table layout — reliable across all email clients) -->
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

      <!-- Bill To -->
      <div class="section">
        <p class="label">Bill To</p>
        <p style="font-size:15px;font-weight:600;color:#e2e8f0;margin:0;">${invoice.client.name}</p>
        ${invoice.client.companyName ? `<p style="font-size:13px;color:#64748b;margin:3px 0 0;">${invoice.client.companyName}</p>` : ""}
        <p style="font-size:13px;color:#64748b;margin:3px 0 0;">${invoice.client.email}</p>
      </div>

      <!-- Line items -->
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

      <!-- Total (table layout — no flex) -->
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
      <!-- Notes -->
      <div class="section" style="border-top:1px solid #1e293b;border-bottom:none;">
        <p class="label">Notes</p>
        <p style="font-size:13px;color:#64748b;margin:0;line-height:1.6;">${invoice.notes}</p>
      </div>`
          : ""
      }

    </div>

    <!-- Pay button -->
    ${
      paymentLink
        ? `
    <div class="pay-wrap">
      <a href="${paymentLink}" class="pay-btn">Pay Now — ${fmt(invoice.totalAmount)}</a>
    </div>
    <p class="pay-link">Or copy this link: <a href="${paymentLink}" style="color:#60a5fa;">${paymentLink}</a></p>`
        : ""
    }

    <!-- Footer -->
    <p style="text-align:center;color:#334155;font-size:11px;margin-top:28px;">
      Sent via <strong>Billd</strong> — Professional invoicing for freelancers
    </p>

  </div>
</body>
</html>`;
}

// ─── DELETE /invoices/:id ─────────────────────────────────────────────────────
// Soft-deletes an invoice by setting deletedAt. It moves to the Trash and can
// be restored within 30 days. Nothing is permanently removed from the DB here.

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


// ─── POST /invoices/:id/restore ───────────────────────────────────────────────
// Restores a soft-deleted invoice back to the active list.

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

// ─── DELETE /invoices/:id/permanent ──────────────────────────────────────────
// Permanently deletes an invoice that is already in the Trash.
// This is irreversible — invoice items are cascade-deleted by the DB.

invoicesRouter.delete("/:id/permanent", async (c) => {
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
    .delete(invoices)
    .where(and(eq(invoic