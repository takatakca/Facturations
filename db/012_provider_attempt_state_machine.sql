-- Apply ONLY to the dedicated Facturations database after migrations 001-011.
-- Provider execution bookkeeping only. This migration performs no Wave/API call.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  draft_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'WAVE'),
  operation text NOT NULL CHECK (operation = 'ISSUE_INVOICE'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 80),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 2147483647),
  parent_attempt_id uuid,
  state text NOT NULL CHECK (state IN (
    'PREPARED','IN_FLIGHT','CONFIRMED','AMBIGUOUS',
    'FAILED_RETRYABLE','FAILED_FINAL','RECONCILED_NOT_FOUND'
  )),
  provider_invoice_id text CHECK (provider_invoice_id IS NULL OR length(provider_invoice_id) BETWEEN 1 AND 512),
  provider_invoice_number text CHECK (provider_invoice_number IS NULL OR length(provider_invoice_number) BETWEEN 1 AND 200),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_:-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  UNIQUE (business_id, draft_id, attempt_no),
  FOREIGN KEY (business_id, draft_id) REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, parent_attempt_id)
    REFERENCES facturations_provider_attempts(business_id,id) ON DELETE RESTRICT,
  CHECK (
    (state = 'CONFIRMED' AND provider_invoice_id IS NOT NULL AND provider_invoice_number IS NOT NULL)
    OR
    (state <> 'CONFIRMED' AND provider_invoice_id IS NULL AND provider_invoice_number IS NULL)
  ),
  CHECK (
    (state IN ('AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL') AND error_code IS NOT NULL)
    OR
    (state NOT IN ('AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL') AND error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS facturations_provider_attempts_draft_idx
  ON facturations_provider_attempts (business_id,draft_id,attempt_no DESC);

CREATE TABLE IF NOT EXISTS facturations_provider_attempt_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  attempt_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL CHECK (to_state IN (
    'PREPARED','IN_FLIGHT','CONFIRMED','AMBIGUOUS',
    'FAILED_RETRYABLE','FAILED_FINAL','RECONCILED_NOT_FOUND'
  )),
  event_code text NOT NULL CHECK (event_code IN (
    'ATTEMPT_PREPARED','ATTEMPT_STARTED','PROVIDER_CONFIRMED',
    'PROVIDER_AMBIGUOUS','PROVIDER_FAILED_RETRYABLE','PROVIDER_FAILED_FINAL',
    'RECONCILIATION_FOUND','RECONCILIATION_NOT_FOUND'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,attempt_id)
    REFERENCES facturations_provider_attempts(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_provider_attempt_events_idx
  ON facturations_provider_attempt_events (business_id,attempt_id,occurred_at,id);

CREATE OR REPLACE FUNCTION facturations_guard_provider_attempt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider attempts cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.parent_attempt_id IS DISTINCT FROM OLD.parent_attempt_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provider attempt identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD.state = 'PREPARED' AND NEW.state = 'IN_FLIGHT')
    OR
    (OLD.state = 'IN_FLIGHT' AND NEW.state IN (
      'CONFIRMED','AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL'
    ))
    OR
    (OLD.state = 'AMBIGUOUS' AND NEW.state IN ('CONFIRMED','RECONCILED_NOT_FOUND'))
  ) THEN
    RAISE EXCEPTION 'invalid provider attempt state transition' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_attempts_guard ON facturations_provider_attempts;
CREATE TRIGGER facturations_provider_attempts_guard
  BEFORE UPDATE OR DELETE ON facturations_provider_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_guard_provider_attempt_update();

CREATE OR REPLACE FUNCTION facturations_reject_provider_attempt_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider attempt events are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS facturations_provider_attempt_events_append_only
  ON facturations_provider_attempt_events;
CREATE TRIGGER facturations_provider_attempt_events_append_only
  BEFORE UPDATE OR DELETE ON facturations_provider_attempt_events
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_provider_attempt_event_mutation();

COMMIT;
