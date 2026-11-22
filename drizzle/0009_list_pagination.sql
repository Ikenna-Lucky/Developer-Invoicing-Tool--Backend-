CREATE INDEX IF NOT EXISTS "clients_owner_page_idx" ON "clients" ("user_id", "created_at", "id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_owner_active_page_idx" ON "invoices" ("user_id", "created_at", "id")
WHERE
    deleted_at IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_owner_trash_page_idx" ON "invoices" ("user_id", "deleted_at", "id")
WHERE
    deleted_at IS NOT NULL;