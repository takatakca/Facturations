-- Apply ONLY to the dedicated Facturations database, after migrations 001-013.
-- Persists a confirmed Wave DRAFT creation before the separate approval mutation.
-- This migration performs no network request and never marks a local invoice issued.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_wave_create_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  execution_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  provider_invoice_id text NOT NULL CHECK (length(provider_invoice_id) BETWEEN 1 AND 512),
  provider_invoice_number text,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, execution_id),
  UNIQUE (business_id, provider_invoice_id),
  FOREIGN KEY (business_id, execution_id)
    REFERENCES facturations_provider_executions(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  CHECK (provider_invoice_number IS NULL OR length(provider_invoice_number) BETWEEN 1 AND 160)
);
CREATE INDEX IF NOT EXISTS facturations_wave_create_confirmations_draft_idx
  ON facturations_wave_create_confirmations (business_id,draft_id,confirmed_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_wave_create_confirmation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wave create confirmations are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS facturations_wave_create_confirmations_append_only
  ON facturations_wave_create_confirmations;
CREATE TRIGGER facturations_wave_create_confirmations_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_create_confirmations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_create_confirmation_mutation();
COMMIT;
