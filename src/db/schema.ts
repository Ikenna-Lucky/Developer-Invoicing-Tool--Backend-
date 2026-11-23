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
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "overdue",
]);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    ownerId: text("owner_id").notNull(),
    action: text("action").notNull(),
    resourceId: text("resource_id").notNull(),
    details: jsonb("details").$type<Record<string, string | null>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ownerTime: index("audit_events_owner_time_idx").on(
      table.ownerId,
      table.occurredAt,
    ),
  }),
);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  // nullable — Google-authenticated users have no password
  passwordHash: text("password_hash"),
  fullName: text("full_name").notNull(),
  googleId: text("google_id").unique(),
  sessionVersion: integer("session_version").notNull().default(0),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
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

export const clients = pgTable(
  "clients",
  {
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
  },
  (table) => ({
    ownerPage: index("clients_owner_page_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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

export type InvoiceIdentity = {
  sender: Pick<
    typeof users.$inferSelect,
    "fullName" | "businessName" | "email" | "address" | "phone" | "logoUrl"
  >;
  client: Pick<
    typeof clients.$inferSelect,
    "name" | "companyName" | "email" | "address" | "phone"
  >;
  source: "issued" | "legacy_backfill";
  capturedAt: string;
};

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
    identitySnapshot: jsonb("identity_snapshot").$type<InvoiceIdentity>(),
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
    activePage: index("invoices_owner_active_page_idx")
      .on(table.userId, table.createdAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    trashPage: index("invoices_owner_trash_page_idx")
      .on(table.userId, table.deletedAt, table.id)
      .where(sql`${table.deletedAt} IS NOT NULL`),
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

export const requestRateLimits = pgTable(
  "request_rate_limits",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiryIndex: index("request_rate_limits_expiry_idx").on(table.expiresAt),
  }),
);

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" }),
  amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).notNull(),
  paidAt: timestamp("paid_at").notNull(),
  stripePaymentId: text("stripe_payment_id").unique(), // Stores the Paystack reference.
  method: text("method").default("paystack").notNull(),
  recordedBy: text("recorded_by"),
  reference: text("reference"),
  idempotencyKey: text("idempotency_key").unique(),
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

export const emailJobs = pgTable(
  "email_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id").references(() => invoices.id, {
      onDelete: "restrict",
    }),
    purpose: text("purpose", {
      enum: ["verification", "password_reset", "invoice"],
    }).notNull(),
    tokenHash: text("token_hash"),
    payload: text("payload"),
    status: text("status", {
      enum: ["pending", "processing", "accepted", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    claimId: text("claim_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    readyIndex: index("email_jobs_ready_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    invoiceIndex: index("email_jobs_invoice_idx").on(table.invoiceId),
    userIndex: index("email_jobs_user_idx").on(table.userId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
