-- Earlier journal entries have timestamps before the initial migration. Repair
-- fields that may have been skipped before applying the new invoice rules.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_google_id_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_google_id_unique" UNIQUE ("google_id");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
CREATE INDEX IF NOT EXISTS "invoices_deleted_at_idx" ON "invoices" ("deleted_at");
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "last_number" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "invoice_counters_number_range" CHECK ("last_number" BETWEEN 0 AND 9007199254740991)
);
INSERT INTO "invoice_counters" ("user_id", "last_number")
SELECT "user_id", max(substring("invoice_number" from '^INV-([0-9]+)$')::bigint)
FROM "invoices" WHERE "invoice_number" ~ '^INV-[0-9]+$' GROUP BY "user_id";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_invoice_number_unique";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_invoice_number_unique" UNIQUE ("user_id", "invoice_number");
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_client_id_clients_id_fk";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT;
ALTER TABLE "payments" DROP CONSTRAINT "payments_invoice_id_invoices_id_fk";
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION "protect_issued_invoice"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_payment boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM payments WHERE invoice_id = OLD.id) INTO has_payment;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.stripe_payment_link IS NOT NULL OR has_payment THEN
      RAISE EXCEPTION 'Issued invoices and payment history cannot be permanently deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' OR OLD.stripe_payment_link IS NOT NULL OR has_payment THEN
    IF ROW(NEW.user_id, NEW.client_id, NEW.invoice_number, NEW.total_amount, NEW.issue_date, NEW.due_date, NEW.notes, NEW.stripe_payment_link)
      IS DISTINCT FROM ROW(OLD.user_id, OLD.client_id, OLD.invoice_number, OLD.total_amount, OLD.issue_date, OLD.due_date, OLD.notes, OLD.stripe_payment_link) THEN
      RAISE EXCEPTION 'Issued invoice details cannot be changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (OLD.status = 'paid' AND NEW.status <> 'paid')
    OR (OLD.status IN ('sent', 'overdue') AND NEW.status = 'draft')
    OR (OLD.status = 'overdue' AND NEW.status = 'sent') THEN
    RAISE EXCEPTION 'Invoice status cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "protect_issued_invoice" BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "protect_issued_invoice"();
--> statement-breakpoint
CREATE FUNCTION "protect_issued_invoice_item"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent invoices%ROWTYPE; parent_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'Invoice items cannot be moved between invoices' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN parent_id := NEW.invoice_id; ELSE parent_id := OLD.invoice_id; END IF;
  SELECT * INTO parent FROM invoices WHERE id = parent_id FOR UPDATE;
  -- The parent is absent when a draft deletion cascades to its items.
  IF FOUND AND (parent.status <> 'draft' OR parent.stripe_payment_link IS NOT NULL
    OR EXISTS(SELECT 1 FROM payments WHERE invoice_id = parent_id)) THEN
    RAISE EXCEPTION 'Issued invoice items cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "protect_issued_invoice_item" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_items"
  FOR EACH ROW EXECUTE FUNCTION "protect_issued_invoice_item"();
