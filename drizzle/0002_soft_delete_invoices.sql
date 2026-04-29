-- Add soft-delete support to invoices
-- deleted_at = NULL  → active invoice
-- deleted_at = timestamp → invoice is in the Trash (restored or purged after 30 days)

ALTER TABLE "invoices" ADD COLUMN "deleted_at" timestamp;

-- Index speeds up the IS NULL filter on every normal list query
CREATE INDEX "invoices_deleted_at_idx" ON "invoices" ("deleted_at");
