ALTER TABLE "payments" ADD COLUMN "method" text DEFAULT 'paystack' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key");
--> statement-breakpoint
-- Payment corrections need an explicit reversal workflow rather than rewriting history.
CREATE FUNCTION billd_protect_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment records cannot be changed or removed';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON payments
FOR EACH STATEMENT EXECUTE FUNCTION billd_protect_payment();
