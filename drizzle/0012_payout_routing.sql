CREATE TABLE "payment_checkouts" (
	"reference" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"payout_account_id" text NOT NULL,
	"subaccount_code" text NOT NULL,
	"mode" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"fee_bearer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_checkouts_invoice_id_unique" UNIQUE("invoice_id"),
	CONSTRAINT "payment_checkouts_routing" CHECK ("payment_checkouts"."mode" IN ('test', 'live') AND "payment_checkouts"."fee_bearer" IN ('account', 'subaccount') AND "payment_checkouts"."amount_kobo" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subaccount_code" text,
	"bank_code" text NOT NULL,
	"account_last4" text NOT NULL,
	"account_name" text NOT NULL,
	"request_hash" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_accounts_owner_mode_unique" UNIQUE("user_id","mode"),
	CONSTRAINT "payout_accounts_mode_code_unique" UNIQUE("mode","subaccount_code"),
	CONSTRAINT "payout_accounts_state" CHECK ("payout_accounts"."mode" IN ('test', 'live') AND (("payout_accounts"."status" = 'pending' AND "payout_accounts"."subaccount_code" IS NULL) OR ("payout_accounts"."status" = 'ready' AND "payout_accounts"."subaccount_code" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paystack_routing_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_checkouts" ADD CONSTRAINT "payment_checkouts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_checkouts" ADD CONSTRAINT "payment_checkouts_payout_account_id_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payout_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Only links issued before this migration may use the legacy unsplit path.
UPDATE invoices SET paystack_routing_required = false WHERE status <> 'draft';
--> statement-breakpoint
CREATE FUNCTION billd_guard_payout_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payout account history cannot be deleted'; END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'ready'
    OR (to_jsonb(NEW) - 'status' - 'subaccount_code') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'subaccount_code')
  THEN RAISE EXCEPTION 'Payout accounts cannot be changed after setup'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_payout_account BEFORE UPDATE OR DELETE ON payout_accounts
FOR EACH ROW EXECUTE FUNCTION billd_guard_payout_account();
--> statement-breakpoint
CREATE FUNCTION billd_guard_payment_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Payment checkout routing is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices i JOIN payout_accounts p ON p.user_id = i.user_id
    WHERE i.id = NEW.invoice_id AND p.id = NEW.payout_account_id AND p.status = 'ready'
    AND p.subaccount_code = NEW.subaccount_code AND p.mode = NEW.mode
    AND i.paystack_routing_required AND i.status = 'draft' AND i.deleted_at IS NULL
    AND i.total_amount * 100 = NEW.amount_kobo)
  THEN RAISE EXCEPTION 'Payment checkout does not match its invoice owner'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_payment_checkout BEFORE INSERT OR UPDATE OR DELETE ON payment_checkouts
FOR EACH ROW EXECUTE FUNCTION billd_guard_payment_checkout();
--> statement-breakpoint
CREATE FUNCTION billd_guard_invoice_routing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.paystack_routing_required IS DISTINCT FROM OLD.paystack_routing_required
  THEN RAISE EXCEPTION 'Issued invoice payment routing cannot be changed'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_invoice_routing BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION billd_guard_invoice_routing();
--> statement-breakpoint
CREATE FUNCTION billd_audit_payout_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(owner_id, action, resource_id, details)
  VALUES (NEW.user_id, CASE WHEN TG_OP = 'INSERT' THEN 'payout.setup_started' ELSE 'payout.setup_completed' END,
    NEW.id, jsonb_build_object('mode', NEW.mode, 'status', NEW.status));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_payout_account AFTER INSERT OR UPDATE ON payout_accounts
FOR EACH ROW EXECUTE FUNCTION billd_audit_payout_account();
