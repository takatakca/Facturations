-- Run ONLY on a NEW, dedicated Facturations database after 001_draft_storage.sql.
-- Never execute on any existing GROUPE TAKATAK production database.
-- Triggers protect application-role writes; DB owners/superusers can disable them.
-- Use a separate least-privilege runtime role with no schema ownership.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice audit events are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS invoice_audit_append_only ON invoice_audit_events;
CREATE TRIGGER invoice_audit_append_only
  BEFORE UPDATE OR DELETE ON invoice_audit_events
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_audit_mutation();

CREATE OR REPLACE FUNCTION facturations_protect_draft_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice drafts cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'invoice draft snapshot and identity are immutable' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_drafts_protect_snapshot ON invoice_drafts;
CREATE TRIGGER invoice_drafts_protect_snapshot
  BEFORE UPDATE OR DELETE ON invoice_drafts
  FOR EACH ROW EXECUTE FUNCTION facturations_protect_draft_snapshot();

COMMIT;
