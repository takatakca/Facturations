-- Apply ONLY to the dedicated Facturations database, after migrations 001-033.
-- Enforces delivery/email provenance in PostgreSQL when application-store validation is bypassed.
-- This migration sends no email and performs no provider request.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_delivery_attempt_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  auth_invoice_id uuid;
  auth_document_id uuid;
BEGIN
  SELECT issued_invoice_id,qualified_document_id
    INTO auth_invoice_id,auth_document_id
    FROM facturations_delivery_authorizations
   WHERE business_id=NEW.business_id
     AND id=NEW.authorization_id
   FOR KEY SHARE;

  IF NOT FOUND OR
     auth_invoice_id<>NEW.issued_invoice_id OR
     auth_document_id<>NEW.qualified_document_id THEN
    RAISE EXCEPTION 'delivery attempt lineage mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_attempt_lineage_guard
  ON facturations_delivery_attempts;
CREATE TRIGGER facturations_delivery_attempt_lineage_guard
  BEFORE INSERT ON facturations_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_delivery_attempt_lineage();

CREATE OR REPLACE FUNCTION facturations_validate_signed_email_evidence_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_mode='SIGNED_WEBHOOK' AND NOT EXISTS (
    SELECT 1
      FROM facturations_delivery_attempts a
     WHERE a.business_id=NEW.business_id
       AND a.qualified_document_id=NEW.qualified_document_id
       AND a.operation_key=NEW.operation_key
       AND a.provider=NEW.provider_key
       AND a.provider_message_id=NEW.provider_message_id
       AND a.state='CONFIRMED'
  ) THEN
    RAISE EXCEPTION 'signed email evidence delivery lineage mismatch'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_signed_email_evidence_lineage_guard
  ON facturations_email_provider_evidence;
CREATE TRIGGER facturations_signed_email_evidence_lineage_guard
  BEFORE INSERT ON facturations_email_provider_evidence
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_signed_email_evidence_lineage();

COMMIT;
