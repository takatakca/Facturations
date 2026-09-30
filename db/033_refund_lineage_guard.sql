-- Apply ONLY to the dedicated Facturations database, after migrations 001-032.
-- Enforces refund lineage in PostgreSQL even when application-store validation is bypassed.
-- This migration never charges, refunds or contacts a payment provider.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_refund_payment_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_invoice_id uuid;
  parent_event_type text;
  parent_provider_key text;
BEGIN
  IF NEW.event_type = 'PAYMENT_RECEIVED' THEN
    IF NEW.related_payment_evidence_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment evidence cannot reference a parent payment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.event_type <> 'REFUND_ISSUED' OR NEW.related_payment_evidence_id IS NULL THEN
    RAISE EXCEPTION 'refund payment lineage is required'
      USING ERRCODE = '23514';
  END IF;

  SELECT issued_invoice_id,event_type,provider_key
    INTO parent_invoice_id,parent_event_type,parent_provider_key
    FROM facturations_payment_evidence
   WHERE business_id = NEW.business_id
     AND id = NEW.related_payment_evidence_id
   FOR KEY SHARE;

  IF NOT FOUND OR
     parent_invoice_id <> NEW.issued_invoice_id OR
     parent_event_type <> 'PAYMENT_RECEIVED' OR
     parent_provider_key <> NEW.provider_key THEN
    RAISE EXCEPTION 'refund payment lineage mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_payment_evidence_refund_lineage_guard
  ON facturations_payment_evidence;
CREATE TRIGGER facturations_payment_evidence_refund_lineage_guard
  BEFORE INSERT ON facturations_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_refund_payment_lineage();

COMMIT;
