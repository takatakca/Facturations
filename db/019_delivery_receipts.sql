-- Apply ONLY to the dedicated Facturations database, after migrations 001-018.
-- Materializes an immutable local receipt from one CONFIRMED delivery attempt.
-- It performs no network request and does not itself prove external delivery.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  attempt_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  issued_invoice_id uuid NOT NULL,
  qualified_document_id uuid NOT NULL,
  qualified_document_sha256 text NOT NULL CHECK (qualified_document_sha256 ~ '^[a-f0-9]{64}$'),
  expected_recipient_email text NOT NULL CHECK (length(expected_recipient_email) BETWEEN 3 AND 254),
  recipient_snapshot_hash text NOT NULL CHECK (recipient_snapshot_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider = 'SIMULATED_EMAIL'),
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 512),
  provider_confirmed_at timestamptz NOT NULL,
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  materialized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, attempt_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, attempt_id)
    REFERENCES facturations_delivery_attempts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_delivery_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, qualified_document_id)
    REFERENCES facturations_qualified_invoice_documents(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_delivery_receipts_invoice_idx
  ON facturations_delivery_receipts (business_id,issued_invoice_id);

CREATE OR REPLACE FUNCTION facturations_reject_delivery_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery receipts are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_receipts_append_only
  ON facturations_delivery_receipts;
CREATE TRIGGER facturations_delivery_receipts_append_only
  BEFORE UPDATE OR DELETE ON facturations_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_delivery_receipt_mutation();

COMMIT;
