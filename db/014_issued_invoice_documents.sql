-- Apply ONLY to the dedicated Facturations database, after migrations 001-013.
-- Stores one immutable PDF byte stream per locally issued invoice.
-- This migration performs no network request and sends no email.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_issued_invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  issued_invoice_id uuid NOT NULL,
  document_kind text NOT NULL DEFAULT 'INVOICE_PDF'
    CHECK (document_kind = 'INVOICE_PDF'),
  render_version text NOT NULL CHECK (length(render_version) BETWEEN 1 AND 80),
  content_type text NOT NULL DEFAULT 'application/pdf'
    CHECK (content_type = 'application/pdf'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 100 AND 2097152),
  pdf_bytes bytea NOT NULL,
  delivery_state text NOT NULL DEFAULT 'NOT_AUTHORIZED'
    CHECK (delivery_state = 'NOT_AUTHORIZED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, issued_invoice_id),
  UNIQUE (business_id, content_sha256),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  CHECK (octet_length(pdf_bytes) = byte_length)
);

CREATE INDEX IF NOT EXISTS facturations_issued_invoice_documents_created_idx
  ON facturations_issued_invoice_documents (business_id, created_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_issued_invoice_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued invoice documents are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_issued_invoice_documents_append_only
  ON facturations_issued_invoice_documents;
CREATE TRIGGER facturations_issued_invoice_documents_append_only
  BEFORE UPDATE OR DELETE ON facturations_issued_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issued_invoice_document_mutation();

COMMIT;
