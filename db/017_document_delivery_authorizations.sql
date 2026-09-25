-- Apply ONLY to the dedicated Facturations database, after migrations 001-016.
-- Records explicit OWNER authorization to deliver one exact archived PDF by email.
-- This migration does NOT send email, expose a download, charge a payment, or call Wave.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_document_delivery_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  document_id uuid NOT NULL,
  issued_invoice_id uuid NOT NULL,
  delivery_channel text NOT NULL CHECK (delivery_channel = 'EMAIL'),
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  official_invoice_number text NOT NULL CHECK (length(official_invoice_number) BETWEEN 1 AND 160),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  issuer_profile_version_id uuid NOT NULL,
  issuer_profile_hash text NOT NULL CHECK (issuer_profile_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'AUTHORIZED_NOT_SENT'
    CHECK (state = 'AUTHORIZED_NOT_SENT'),
  authorized_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation = 'AUTHORIZE_EMAIL_DELIVERY'),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, document_id)
    REFERENCES facturations_issued_invoice_documents(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issuer_profile_version_id)
    REFERENCES facturations_issuer_profile_versions(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorized_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_delivery_authorizations_latest_idx
  ON facturations_document_delivery_authorizations
  (business_id, authorized_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_delivery_authorization_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery authorizations are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_document_delivery_authorizations_append_only
  ON facturations_document_delivery_authorizations;
CREATE TRIGGER facturations_document_delivery_authorizations_append_only
  BEFORE UPDATE OR DELETE ON facturations_document_delivery_authorizations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_delivery_authorization_mutation();

COMMIT;
