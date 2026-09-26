-- Apply ONLY to the dedicated Facturations database, after migrations 001-016.
-- Records an OWNER authorization to deliver one exact qualified PDF to one exact recipient.
-- This migration sends no email and performs no external request.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_delivery_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  issued_invoice_id uuid NOT NULL,
  qualified_document_id uuid NOT NULL,
  qualified_document_sha256 text NOT NULL CHECK (qualified_document_sha256 ~ '^[a-f0-9]{64}$'),
  expected_recipient_email text NOT NULL CHECK (length(expected_recipient_email) BETWEEN 3 AND 254),
  recipient_snapshot_hash text NOT NULL CHECK (recipient_snapshot_hash ~ '^[a-f0-9]{64}$'),
  authorized_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation = 'AUTHORIZE_QUALIFIED_PDF_DELIVERY'),
  state text NOT NULL DEFAULT 'AUTHORIZED_PENDING_DELIVERY'
    CHECK (state = 'AUTHORIZED_PENDING_DELIVERY'),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, issued_invoice_id),
  UNIQUE (business_id, qualified_document_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, qualified_document_id)
    REFERENCES facturations_qualified_invoice_documents(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorized_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_delivery_authorizations_recipient_idx
  ON facturations_delivery_authorizations (business_id, expected_recipient_email);

CREATE OR REPLACE FUNCTION facturations_reject_delivery_authorization_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery authorizations are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_authorizations_append_only
  ON facturations_delivery_authorizations;
CREATE TRIGGER facturations_delivery_authorizations_append_only
  BEFORE UPDATE OR DELETE ON facturations_delivery_authorizations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_delivery_authorization_mutation();

COMMIT;
