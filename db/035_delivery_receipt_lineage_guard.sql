-- Apply ONLY to the dedicated Facturations database, after migrations 001-034.
-- Enforces immutable delivery receipt provenance in PostgreSQL when application-store validation is bypassed.
-- This migration sends no email and performs no provider request.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_delivery_receipt_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_authorization_id uuid;
  source_invoice_id uuid;
  source_document_id uuid;
  source_provider text;
  source_operation_key text;
  source_state text;
  source_provider_message_id text;
  source_finished_at timestamptz;
  source_document_sha256 text;
  source_recipient_email text;
  source_recipient_hash text;
  source_authorization_state text;
  actual_document_sha256 text;
  source_document_delivery_state text;
  source_invoice_status text;
  source_invoice_delivery_state text;
BEGIN
  SELECT
      t.authorization_id,
      t.issued_invoice_id,
      t.qualified_document_id,
      t.provider,
      t.operation_key,
      t.state,
      t.provider_message_id,
      t.finished_at,
      a.qualified_document_sha256,
      a.expected_recipient_email,
      a.recipient_snapshot_hash,
      a.state,
      q.content_sha256,
      q.delivery_state,
      i.status,
      i.delivery_state
    INTO
      source_authorization_id,
      source_invoice_id,
      source_document_id,
      source_provider,
      source_operation_key,
      source_state,
      source_provider_message_id,
      source_finished_at,
      source_document_sha256,
      source_recipient_email,
      source_recipient_hash,
      source_authorization_state,
      actual_document_sha256,
      source_document_delivery_state,
      source_invoice_status,
      source_invoice_delivery_state
    FROM facturations_delivery_attempts t
    JOIN facturations_delivery_authorizations a
      ON a.business_id=t.business_id
     AND a.id=t.authorization_id
    JOIN facturations_qualified_invoice_documents q
      ON q.business_id=t.business_id
     AND q.id=t.qualified_document_id
    JOIN facturations_issued_invoices i
      ON i.business_id=t.business_id
     AND i.id=t.issued_invoice_id
   WHERE t.business_id=NEW.business_id
     AND t.id=NEW.attempt_id
   FOR KEY SHARE OF t,a,q,i;

  IF NOT FOUND OR
     source_state<>'CONFIRMED' OR
     source_provider<>'SIMULATED_EMAIL' OR
     source_provider_message_id IS NULL OR
     source_finished_at IS NULL OR
     source_authorization_state<>'AUTHORIZED_PENDING_DELIVERY' OR
     source_invoice_status<>'ISSUED_CONFIRMED' OR
     source_document_delivery_state<>'NOT_AUTHORIZED' OR
     source_invoice_delivery_state<>'NOT_AUTHORIZED' OR
     source_document_sha256<>actual_document_sha256 OR
     NEW.authorization_id<>source_authorization_id OR
     NEW.issued_invoice_id<>source_invoice_id OR
     NEW.qualified_document_id<>source_document_id OR
     NEW.qualified_document_sha256<>source_document_sha256 OR
     NEW.expected_recipient_email<>source_recipient_email OR
     NEW.recipient_snapshot_hash<>source_recipient_hash OR
     NEW.provider<>source_provider OR
     NEW.provider_message_id<>source_provider_message_id OR
     NEW.operation_key<>source_operation_key OR
     NEW.provider_confirmed_at<>source_finished_at THEN
    RAISE EXCEPTION 'delivery receipt lineage mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_receipt_lineage_guard
  ON facturations_delivery_receipts;
CREATE TRIGGER facturations_delivery_receipt_lineage_guard
  BEFORE INSERT ON facturations_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_delivery_receipt_lineage();

COMMIT;
