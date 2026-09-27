-- Apply ONLY to the dedicated Facturations database, after migrations 001-011.
-- This persists provider execution state; it performs no network request by itself.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_provider_issuance_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'WAVE'),
  operation_key text NOT NULL CHECK (
    length(operation_key) BETWEEN 24 AND 120
    AND operation_key ~ '^[A-Za-z0-9_-]+$'
  ),
  state text NOT NULL CHECK (
    state IN ('PREPARED','IN_PROGRESS','AMBIGUOUS','CONFIRMED','FAILED')
  ),
  provider_invoice_id text,
  provider_invoice_number text,
  outcome_code text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (business_id, authorization_id),
  UNIQUE (business_id, provider, operation_key),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  CHECK (
    (state = 'PREPARED'
      AND started_at IS NULL AND finished_at IS NULL
      AND provider_invoice_id IS NULL AND provider_invoice_number IS NULL
      AND outcome_code IS NULL)
    OR
    (state = 'IN_PROGRESS'
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND provider_invoice_id IS NULL AND provider_invoice_number IS NULL
      AND outcome_code IS NULL)
    OR
    (state = 'AMBIGUOUS'
      AND started_at IS NOT NULL AND finished_at IS NULL
      AND provider_invoice_id IS NULL AND provider_invoice_number IS NULL
      AND outcome_code IS NOT NULL)
    OR
    (state = 'CONFIRMED'
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND provider_invoice_id IS NOT NULL AND provider_invoice_number IS NOT NULL)
    OR
    (state = 'FAILED'
      AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND provider_invoice_id IS NULL AND provider_invoice_number IS NULL
      AND outcome_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS facturations_provider_issuance_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  attempt_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL CHECK (
    to_state IN ('PREPARED','IN_PROGRESS','AMBIGUOUS','CONFIRMED','FAILED')
  ),
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, attempt_id)
    REFERENCES facturations_provider_issuance_attempts(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_provider_issuance_events_attempt_idx
  ON facturations_provider_issuance_events (business_id,attempt_id,occurred_at,id);

CREATE OR REPLACE FUNCTION facturations_reject_provider_issuance_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider issuance events are append only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_issuance_events_append_only
  ON facturations_provider_issuance_events;
CREATE TRIGGER facturations_provider_issuance_events_append_only
  BEFORE UPDATE OR DELETE ON facturations_provider_issuance_events
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_provider_issuance_event_mutation();

COMMIT;
