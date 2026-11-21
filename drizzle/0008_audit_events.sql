CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"owner_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_id" text NOT NULL,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_owner_time_idx" ON "audit_events" ("owner_id","occurred_at");
--> statement-breakpoint
-- Triggers keep history in the same transaction, including writes outside HTTP.
-- owner_id identifies whose data changed, not who initiated the change.
CREATE FUNCTION billd_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  old_data jsonb;
  account_id text;
  event_action text;
  event_details jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD);
  ELSE row_data := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN old_data := to_jsonb(OLD); END IF;

  IF TG_TABLE_NAME = 'users' THEN
    account_id := row_data->>'id';
    IF TG_OP = 'INSERT' THEN event_action := 'account.created';
    ELSIF TG_OP = 'DELETE' THEN event_action := 'account.deleted';
    ELSIF old_data->'password_hash' IS DISTINCT FROM row_data->'password_hash' THEN event_action := 'account.password_changed';
    ELSIF old_data->'email_verified_at' IS DISTINCT FROM row_data->'email_verified_at' THEN event_action := 'account.verification_changed';
    ELSIF (old_data - 'updated_at') IS DISTINCT FROM (row_data - 'updated_at') THEN event_action := 'account.updated';
    END IF;
  ELSIF TG_TABLE_NAME = 'clients' THEN
    account_id := row_data->>'user_id';
    IF TG_OP = 'UPDATE' AND (old_data - 'updated_at') = (row_data - 'updated_at') THEN RETURN NULL; END IF;
    event_action := CASE TG_OP WHEN 'INSERT' THEN 'client.created' WHEN 'UPDATE' THEN 'client.updated' ELSE 'client.deleted' END;
  ELSIF TG_TABLE_NAME = 'invoices' THEN
    account_id := row_data->>'user_id';
    IF TG_OP = 'INSERT' THEN event_action := 'invoice.created';
    ELSIF TG_OP = 'DELETE' THEN event_action := 'invoice.deleted';
    ELSIF old_data->'status' IS DISTINCT FROM row_data->'status' THEN
      event_action := 'invoice.status_changed';
      event_details := jsonb_build_object('from', old_data->>'status', 'to', row_data->>'status');
    ELSIF old_data->'deleted_at' IS DISTINCT FROM row_data->'deleted_at' THEN
      event_action := CASE WHEN row_data->>'deleted_at' IS NULL THEN 'invoice.restored' ELSE 'invoice.archived' END;
    ELSIF (old_data - 'updated_at') IS DISTINCT FROM (row_data - 'updated_at') THEN event_action := 'invoice.updated';
    END IF;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    SELECT user_id INTO account_id FROM invoices WHERE id = row_data->>'invoice_id';
    event_action := 'invoice.items_changed';
    row_data := jsonb_build_object('id', row_data->>'invoice_id');
  ELSIF TG_TABLE_NAME = 'payments' THEN
    SELECT user_id INTO account_id FROM invoices WHERE id = row_data->>'invoice_id';
    event_action := CASE TG_OP WHEN 'INSERT' THEN 'payment.recorded' WHEN 'UPDATE' THEN 'payment.updated' ELSE 'payment.deleted' END;
    event_details := jsonb_build_object('invoiceId', row_data->>'invoice_id', 'amountPaid', row_data->>'amount_paid');
  ELSIF TG_TABLE_NAME = 'refresh_tokens' THEN
    account_id := row_data->>'user_id';
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM refresh_tokens WHERE session_id = row_data->>'session_id' AND id <> row_data->>'id'
    ) THEN event_action := 'session.created';
    ELSIF TG_OP = 'UPDATE' AND old_data->>'revoked' = 'false' AND row_data->>'revoked' = 'true' THEN event_action := 'session.revoked';
    ELSIF TG_OP = 'DELETE' AND row_data->>'revoked' = 'false' THEN event_action := 'session.removed';
    END IF;
    row_data := jsonb_build_object('id', row_data->>'session_id');
  ELSIF TG_TABLE_NAME = 'email_jobs' THEN
    account_id := row_data->>'user_id';
    IF TG_OP = 'INSERT' THEN event_action := 'email.queued';
    ELSIF old_data->'status' IS DISTINCT FROM row_data->'status' AND row_data->>'status' IN ('accepted', 'failed', 'cancelled') THEN
      event_action := 'email.' || (row_data->>'status');
    END IF;
    event_details := jsonb_build_object('purpose', row_data->>'purpose');
  END IF;
  IF account_id IS NOT NULL AND event_action IS NOT NULL THEN
    INSERT INTO audit_events(owner_id, action, resource_id, details)
    VALUES(account_id, event_action, row_data->>'id', event_details);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER clients_audit AFTER INSERT OR UPDATE OR DELETE ON clients FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER invoices_audit AFTER INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER invoice_items_audit AFTER INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER payments_audit AFTER INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER sessions_audit AFTER INSERT OR UPDATE OR DELETE ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
CREATE TRIGGER email_jobs_audit AFTER INSERT OR UPDATE ON email_jobs FOR EACH ROW EXECUTE FUNCTION billd_audit_change();
--> statement-breakpoint
CREATE FUNCTION billd_protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events cannot be changed or removed';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION billd_protect_audit();
