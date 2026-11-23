ALTER TABLE "invoices" ADD COLUMN "identity_snapshot" jsonb;
--> statement-breakpoint
CREATE FUNCTION billd_invoice_identity(owner_id text, customer_id text, capture_source text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'sender', jsonb_build_object('fullName', u.full_name, 'businessName', u.business_name,
      'email', u.email, 'address', u.address, 'phone', u.phone, 'logoUrl', u.logo_url),
    'client', jsonb_build_object('name', c.name, 'companyName', c.company_name,
      'email', c.email, 'address', c.address, 'phone', c.phone),
    'source', capture_source, 'capturedAt', statement_timestamp()
  ) FROM users u JOIN clients c ON c.id = customer_id WHERE u.id = owner_id;
$$;
--> statement-breakpoint
-- The original identity cannot be reconstructed reliably for existing invoices.
UPDATE invoices SET identity_snapshot = billd_invoice_identity(user_id, client_id, 'legacy_backfill')
WHERE status <> 'draft';
--> statement-breakpoint
CREATE FUNCTION billd_capture_invoice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.identity_snapshot IS NOT NULL THEN
      IF NEW.identity_snapshot IS DISTINCT FROM OLD.identity_snapshot THEN
        RAISE EXCEPTION 'Issued invoice identity cannot be changed';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.status <> 'draft' THEN
    NEW.identity_snapshot := billd_invoice_identity(NEW.user_id, NEW.client_id, 'issued');
    IF NEW.identity_snapshot IS NULL THEN RAISE EXCEPTION 'Invoice identity was not found'; END IF;
  ELSIF NEW.identity_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'Draft invoices cannot have an issued identity';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER capture_invoice_identity BEFORE INSERT OR UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION billd_capture_invoice_identity();
