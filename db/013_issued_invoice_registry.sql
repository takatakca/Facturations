-- Apply ONLY to the dedicated Facturations database, after migrations 001-012.
-- Materializes a local immutable issued-invoice record only after a provider attempt
-- has already reached CONFIRMED. This migration performs no network request and sends no email.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_issued_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'WAVE'),
  provider_invoice_id text NOT NULL CHECK (length(provider_invoice_id) BETWEEN 1 AND 512),
  official_invoice_number text NOT NULL CHECK (length(official_invoice_number) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  issued_snapshot jsonb NOT NULL CHECK (jsonb_typeof(issued_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'ISSUED_CONFIRMED'
    CHECK (status = 'ISSUED_CONFIRMED'),
  delivery_state text NOT NULL DEFAULT 'NOT_AUTHORIZED'
    CHECK (delivery_state = 'NOT_AUTHORIZED'),
  provider_confirmed_at timestamptz NOT NULL,
  materialized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, authorization_id),
  UNIQUE (business_id, draft_id),
  UNIQUE (business_id, attempt_id),
  UNIQUE (business_id, provider, provider_invoice_id),
  UNIQUE (business_id, provider, official_invoice_number),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, attempt_id)
    REFERENCES facturations_provider_issuance_attempts(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_issued_invoices_number_idx
  ON facturations_issued_invoices (business_id, official_invoice_number);

CREATE OR REPLACE FUNCTION facturations_reject_issued_invoice_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued invoice registry is immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_issued_invoices_append_only
  ON facturations_issued_invoices;
CREATE TRIGGER facturations_issued_invoices_append_only
  BEFORE UPDATE OR DELETE ON facturations_issued_invoices
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issued_invoice_mutation();

COMMIT;
