-- Apply ONLY to the dedicated Facturations database, after migrations 001-039.
-- Enforces Wave provider-attempt provenance, state transitions and append-only transition ledger.
-- This migration performs no Wave/API/network request.
BEGIN;

CREATE UNIQUE INDEX facturations_issuance_authorizations_attempt_source_idx
  ON facturations_issuance_authorizations
     (business_id,id,draft_id,provider);

ALTER TABLE facturations_provider_issuance_attempts
  ADD CONSTRAINT facturations_provider_attempt_authorization_draft_fk
  FOREIGN KEY (business_id,authorization_id,draft_id,provider)
  REFERENCES facturations_issuance_authorizations
    (business_id,id,draft_id,provider)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION facturations_validate_provider_attempt_state_machine()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PREPARED' OR
       NEW.started_at IS NOT NULL OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_invoice_id IS NOT NULL OR
       NEW.provider_invoice_number IS NOT NULL OR
       NEW.outcome_code IS NOT NULL THEN
      RAISE EXCEPTION 'provider issuance attempt must be created PREPARED'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id<>OLD.id OR
     NEW.business_id<>OLD.business_id OR
     NEW.authorization_id<>OLD.authorization_id OR
     NEW.draft_id<>OLD.draft_id OR
     NEW.provider<>OLD.provider OR
     NEW.operation_key<>OLD.operation_key OR
     NEW.prepared_at<>OLD.prepared_at THEN
    RAISE EXCEPTION 'provider issuance attempt identity is immutable'
      USING ERRCODE='23514';
  END IF;

  IF NEW.state=OLD.state THEN
    RAISE EXCEPTION 'provider issuance attempt state update must transition'
      USING ERRCODE='23514';
  END IF;

  IF NOT (
    (OLD.state='PREPARED' AND NEW.state='IN_PROGRESS') OR
    (OLD.state='IN_PROGRESS' AND NEW.state IN ('AMBIGUOUS','CONFIRMED','FAILED')) OR
    (OLD.state='AMBIGUOUS' AND NEW.state IN ('CONFIRMED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid provider issuance attempt state transition'
      USING ERRCODE='23514';
  END IF;

  IF OLD.state='PREPARED' AND NEW.state='IN_PROGRESS' THEN
    IF NEW.started_at IS NULL OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_invoice_id IS NOT NULL OR
       NEW.provider_invoice_number IS NOT NULL OR
       NEW.outcome_code IS NOT NULL OR
       NEW.started_at<NEW.prepared_at THEN
      RAISE EXCEPTION 'invalid provider issuance start transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='AMBIGUOUS' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_invoice_id IS NOT NULL OR
       NEW.provider_invoice_number IS NOT NULL OR
       NEW.outcome_code IS NULL THEN
      RAISE EXCEPTION 'invalid provider issuance ambiguous transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='CONFIRMED' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NULL OR
       NEW.provider_invoice_id IS NULL OR
       NEW.provider_invoice_number IS NULL OR
       NEW.finished_at<NEW.started_at OR
       (OLD.state='IN_PROGRESS' AND NEW.outcome_code IS NOT NULL) OR
       (OLD.state='AMBIGUOUS' AND NEW.outcome_code<>'RECONCILED_CONFIRMED') THEN
      RAISE EXCEPTION 'invalid provider issuance confirmed transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='FAILED' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NULL OR
       NEW.provider_invoice_id IS NOT NULL OR
       NEW.provider_invoice_number IS NOT NULL OR
       NEW.outcome_code IS NULL OR
       NEW.finished_at<NEW.started_at THEN
      RAISE EXCEPTION 'invalid provider issuance failed transition'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_attempt_state_machine_guard
  ON facturations_provider_issuance_attempts;
CREATE TRIGGER facturations_provider_attempt_state_machine_guard
  BEFORE INSERT OR UPDATE ON facturations_provider_issuance_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_provider_attempt_state_machine();

CREATE OR REPLACE FUNCTION facturations_validate_provider_issuance_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
  attempt_outcome_code text;
  prior_to_state text;
  prior_occurred_at timestamptz;
BEGIN
  SELECT state,outcome_code
    INTO attempt_state,attempt_outcome_code
    FROM facturations_provider_issuance_attempts
   WHERE business_id=NEW.business_id
     AND id=NEW.attempt_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider issuance event attempt not found'
      USING ERRCODE='23514';
  END IF;

  SELECT to_state,occurred_at
    INTO prior_to_state,prior_occurred_at
    FROM facturations_provider_issuance_events
   WHERE business_id=NEW.business_id
     AND attempt_id=NEW.attempt_id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.from_state IS NOT NULL OR
       NEW.to_state<>'PREPARED' OR
       NEW.reason_code<>'OWNER_AUTHORIZATION_READY' OR
       attempt_state<>'PREPARED' THEN
      RAISE EXCEPTION 'invalid initial provider issuance event'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.from_state IS DISTINCT FROM prior_to_state OR
     NEW.to_state<>attempt_state OR
     NEW.occurred_at<prior_occurred_at OR
     NOT (
       (NEW.from_state='PREPARED' AND NEW.to_state='IN_PROGRESS') OR
       (NEW.from_state='IN_PROGRESS' AND NEW.to_state IN ('AMBIGUOUS','CONFIRMED','FAILED')) OR
       (NEW.from_state='AMBIGUOUS' AND NEW.to_state IN ('CONFIRMED','FAILED'))
     ) THEN
    RAISE EXCEPTION 'provider issuance event transition mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.to_state='IN_PROGRESS' AND NEW.reason_code<>'ADAPTER_STARTED' THEN
    RAISE EXCEPTION 'provider issuance start event reason mismatch'
      USING ERRCODE='23514';
  ELSIF NEW.to_state='CONFIRMED' AND NEW.reason_code<>'PROVIDER_CONFIRMED' THEN
    RAISE EXCEPTION 'provider issuance confirmed event reason mismatch'
      USING ERRCODE='23514';
  ELSIF NEW.to_state IN ('AMBIGUOUS','FAILED') AND
        NEW.reason_code IS DISTINCT FROM attempt_outcome_code THEN
    RAISE EXCEPTION 'provider issuance outcome event reason mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_issuance_event_insert_guard
  ON facturations_provider_issuance_events;
CREATE TRIGGER facturations_provider_issuance_event_insert_guard
  BEFORE INSERT ON facturations_provider_issuance_events
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_provider_issuance_event_insert();

CREATE OR REPLACE FUNCTION facturations_require_provider_attempt_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_to_state text;
BEGIN
  SELECT to_state
    INTO latest_to_state
    FROM facturations_provider_issuance_events
   WHERE business_id=NEW.business_id
     AND attempt_id=NEW.id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND OR latest_to_state<>NEW.state THEN
    RAISE EXCEPTION 'provider issuance attempt transition ledger required'
      USING ERRCODE='23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS facturations_provider_attempt_ledger_required
  ON facturations_provider_issuance_attempts;
CREATE CONSTRAINT TRIGGER facturations_provider_attempt_ledger_required
  AFTER INSERT OR UPDATE ON facturations_provider_issuance_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION facturations_require_provider_attempt_ledger();

COMMIT;
