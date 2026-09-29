-- Apply ONLY to the dedicated Facturations database, after migrations 001-041.
-- Enforces byte-level integrity and canonical provenance for immutable issued-invoice PDFs.
-- This migration performs no network request and sends no email.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_issued_invoice_document_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_status text;
  source_delivery_state text;
  source_materialized_at timestamptz;
  actual_sha256 text;
  pdf_tail bytea;
BEGIN
  SELECT status,delivery_state,materialized_at
    INTO source_status,source_delivery_state,source_materialized_at
    FROM facturations_issued_invoices
   WHERE business_id=NEW.business_id
     AND id=NEW.issued_invoice_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issued invoice document source not found'
      USING ERRCODE='23514';
  END IF;

  actual_sha256 := encode(sha256(NEW.pdf_bytes),'hex');
  pdf_tail := substring(
    NEW.pdf_bytes
    FROM greatest(1,octet_length(NEW.pdf_bytes)-31)
  );

  IF source_status<>'ISSUED_CONFIRMED' OR
     source_delivery_state<>'NOT_AUTHORIZED' OR
     NEW.document_kind<>'INVOICE_PDF' OR
     NEW.render_version<>'invoice-pdf-v1-winansi' OR
     NEW.content_type<>'application/pdf' OR
     NEW.byte_length<>octet_length(NEW.pdf_bytes) OR
     NEW.content_sha256<>actual_sha256 OR
     substring(NEW.pdf_bytes FROM 1 FOR 5)<>decode('255044462d','hex') OR
     position(decode('2525454f46','hex') IN pdf_tail)=0 OR
     NEW.delivery_state<>'NOT_AUTHORIZED' OR
     NEW.created_at<source_materialized_at THEN
    RAISE EXCEPTION 'issued invoice document integrity mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_issued_invoice_document_integrity_guard
  ON facturations_issued_invoice_documents;
CREATE TRIGGER facturations_issued_invoice_document_integrity_guard
  BEFORE INSERT ON facturations_issued_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_issued_invoice_document_integrity();

COMMIT;
