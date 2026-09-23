-- Apply ONLY to the dedicated Facturations database, after migrations 001-011.
-- Provider execution remains internal state only. No external API call is performed by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_provider_issuance_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'WAVE'),
  attempt_key text NOT NULL CHECK (length(attempt_key) BETWEEN 16 AND 80),
  started_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, authorization_id, attempt_key),
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_provider_issuance_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  attempt_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'CONFIRMED','AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL'
  )),
  provider_invoice_id text,
  provider_invoice_number text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, attempt_id),
  FOREIGN KEY (business_id, attempt_id)
    REFERENCES facturations_provider_issuance_attempts(business_id,id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'CONFIRMED'
      AND provider_invoice_id IS NOT NULL
      AND length(provider_invoice_id) BETWEEN 1 AND 200
      AND provider_invoice_number IS NOT NULL
      AND length(provider_invoice_number) BETWEEN 1 AND 120)
    OR
    (outcome <> 'CONFIRMED'
      AND provider_invoice_id IS NULL
      AND provider_invoice_number IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS facturations_provider_issuance_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  attempt_id uuid NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('CONFIRMED_EXISTING','NOT_FOUND')),
  provider_invoice_id text,
  provider_invoice_number text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, attempt_id),
  FOREIGN KEY (business_id, attempt_id)
    REFERENCES facturations_provider_issuance_attempts(business_id,id) ON DELETE RESTRICT,
  CHECK (
    (resolution = 'CONFIRMED_EXISTING'
      AND provider_invoice_id IS NOT NULL
      AND length(provider_invoice_id) BETWEEN 1 AND 200
      AND provider_invoice_number IS NOT NULL
      AND length(provider_invoice_number) BETWEEN 1 AND 120)
    OR
    (resolution = 'NOT_FOUND'
      AND provider_invoice_id IS NULL
      AND provider_invoice_number IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS facturations_provider_attempts_authorization_idx
  ON facturations_provider_issuance_attempts (business_id, authorization_id, started_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_provider_execution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider execution records are append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_attempts_append_only
  ON facturations_provider_issuance_attempts;
CREATE TRIGGER facturations_provider_attempts_append_only
  BEFORE UPDATE OR DELETE ON facturations_provider_issuance_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_provider_execution_mutation();

DROP TRIGGER IF EXISTS facturations_provider_results_append_only
  ON facturations_provider_issuance_results;
CREATE TRIGGER facturations_provider_results_append_only
  BEFORE UPDATE OR DELETE ON facturations_provider_issuance_results
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_provider_execution_mutation();

DROP TRIGGER IF EXISTS facturations_provider_reconciliations_append_only
  ON facturations_provider_issuance_reconciliations;
CREATE TRIGGER facturations_provider_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON facturations_provider_issuance_reconciliations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_provider_execution_mutation();

COMMIT;
