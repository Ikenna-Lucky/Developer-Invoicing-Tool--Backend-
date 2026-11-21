import {
  pgTable,
  text,
  timestamp,
  numeric,
  boolean,
  pgEnum,
  bigint,
  unique,
  check,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "overdue",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  // nullable — Google-authenticated users have no password
  passwordHash: text("password_hash"),
  fullName: text("full_name").notNull(),
  googleId: text("google_id").unique(),
  sessionVersion: integer("session_version").notNull().default(0),
  businessName: text("business_name"),
  logoUrl: text("logo_url"),
  address: text("address"),
  phone: text("phone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Refresh tokens — stored so individual sessions can be revoked (logout, password change, etc.)
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    sessionId: text("session_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revoked: boolean("revoked").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    activeSession: uniqueIndex("refresh_tokens_active_session_unique")
      .on(table.sessionId)
      .where(sql`${table.revoked} = false`),
    userIndex: index("refresh_tokens_user_id_idx").on(table.userId),
  }),
);

// Password reset tokens — one-time use, we only store the hash
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const clients = pgTable("clients", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  address: text("address"),
  phone: text("phone"),
  companyName: text("company_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const invoiceCounters = pgTable(
  "invoice_counters",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    lastNumber: bigint("last_number", { mode: "number" }).notNull().default(0),
  },
  (table) => ({
    numberRange: check(
      "invoice_counters_number_range",
      sql`${table.lastNumber} between 0 and 9007199254740991`,
    ),
  }),
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(), // e.g. INV-0001
    status: invoiceStatusEnum("status").default("draft").notNull(),
    issueDate: timestamp("issue_date").notNull(),
    dueDate: timestamp("due_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    notes: text("notes"),
    pdfUrl: text("pdf_url"), // Reserved for a stored PDF URL.
    stripePaymentLink: text("stripe_payment_link"), // Stores the Paystack checkout URL.
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // A timestamp moves the invoice to Trash; null keeps it active.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    userInvoiceNumber: unique("invoices_user_invoice_number_unique").on(
      table.userId,
      table.invoiceNumber,
    ),
    deletedAtIndex: index("invoices_deleted_at_idx").on(table.deletedAt),
  }),
);

export const invoiceItems = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
  rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(), // quantity * rate
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" }),
  amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).notNull(),
  paidAt: timestamp("paid_at").notNull(),
  stripePaymentId: text("stripe_payment_id").unique(), // Stores the Paystack reference.
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Relations — needed for the `with` syntax in db.query.* calls
export const clientsRelations = relations(clients, ({ many }) => ({
  invoices: many(invoices),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  client: one(clients, {
    fields: [invoices.clientId],
    references: [clients.id],
  }),
  items: many(invoiceItems),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceItems.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, {
    fields: [payments.invoiceId],
    references: [invoices.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
