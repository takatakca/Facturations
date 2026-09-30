-- Apply ONLY to the dedicated Facturations database, after migrations 001-038.
-- Enforces the delivery-attempt state machine and its append-only transition ledger in PostgreSQL.
-- This migration sends no email and performs no provider request.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_delivery_attempt_state_machine()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PREPARED' OR
       NEW.started_at IS NOT NULL OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_message_id IS NOT NULL OR
       NEW.outcome_code IS NOT NULL THEN
      RAISE EXCEPTION 'delivery attempt must be created PREPARED'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id<>OLD.id OR
     NEW.business_id<>OLD.business_id OR
     NEW.authorization_id<>OLD.authorization_id OR
     NEW.issued_invoice_id<>OLD.issued_invoice_id OR
     NEW.qualified_document_id<>OLD.qualified_document_id OR
     NEW.provider<>OLD.provider OR
     NEW.operation_key<>OLD.operation_key OR
     NEW.prepared_at<>OLD.prepared_at THEN
    RAISE EXCEPTION 'delivery attempt identity is immutable'
      USING ERRCODE='23514';
  END IF;

  IF NEW.state=OLD.state THEN
    RAISE EXCEPTION 'delivery attempt state update must transition'
      USING ERRCODE='23514';
  END IF;

  IF NOT (
    (OLD.state='PREPARED' AND NEW.state='IN_PROGRESS') OR
    (OLD.state='IN_PROGRESS' AND NEW.state IN ('AMBIGUOUS','CONFIRMED','FAILED')) OR
    (OLD.state='AMBIGUOUS' AND NEW.state IN ('CONFIRMED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid delivery attempt state transition'
      USING ERRCODE='23514';
  END IF;

  IF OLD.state='PREPARED' AND NEW.state='IN_PROGRESS' THEN
    IF NEW.started_at IS NULL OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_message_id IS NOT NULL OR
       NEW.outcome_code IS NOT NULL OR
       NEW.started_at<NEW.prepared_at THEN
      RAISE EXCEPTION 'invalid delivery attempt start transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='AMBIGUOUS' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NOT NULL OR
       NEW.provider_message_id IS NOT NULL OR
       NEW.outcome_code IS NULL THEN
      RAISE EXCEPTION 'invalid delivery attempt ambiguous transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='CONFIRMED' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NULL OR
       NEW.provider_message_id IS NULL OR
       NEW.finished_at<NEW.started_at OR
       (OLD.state='IN_PROGRESS' AND NEW.outcome_code IS NOT NULL) OR
       (OLD.state='AMBIGUOUS' AND NEW.outcome_code<>'RECONCILED_CONFIRMED') THEN
      RAISE EXCEPTION 'invalid delivery attempt confirmed transition'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.state='FAILED' THEN
    IF NEW.started_at IS DISTINCT FROM OLD.started_at OR
       NEW.finished_at IS NULL OR
       NEW.provider_message_id IS NOT NULL OR
       NEW.outcome_code IS NULL OR
       NEW.finished_at<NEW.started_at THEN
      RAISE EXCEPTION 'invalid delivery attempt failed transition'
        USING ERRCODE='23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_attempt_state_machine_guard
  ON facturations_delivery_attempts;
CREATE TRIGGER facturations_delivery_attempt_state_machine_guard
  BEFORE INSERT OR UPDATE ON facturations_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_delivery_attempt_state_machine();

CREATE OR REPLACE FUNCTION facturations_validate_delivery_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_state text;
  attempt_outcome_code text;
  prior_to_state text;
  prior_occurred_at timestamptz;
BEGIN
  SELECT state,outcome_code
    INTO attempt_state,attempt_outcome_code
    FROM facturations_delivery_attempts
   WHERE business_id=NEW.business_id
     AND id=NEW.attempt_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery event attempt not found'
      USING ERRCODE='23514';
  END IF;

  SELECT to_state,occurred_at
    INTO prior_to_state,prior_occurred_at
    FROM facturations_delivery_events
   WHERE business_id=NEW.business_id
     AND attempt_id=NEW.attempt_id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.from_state IS NOT NULL OR
       NEW.to_state<>'PREPARED' OR
       NEW.reason_code<>'OWNER_DELIVERY_AUTHORIZATION_READY' OR
       attempt_state<>'PREPARED' THEN
      RAISE EXCEPTION 'invalid initial delivery event'
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
    RAISE EXCEPTION 'delivery event transition mismatch'
      USING ERRCODE='23514';
  END IF;

  IF NEW.to_state='IN_PROGRESS' AND NEW.reason_code<>'ADAPTER_STARTED' THEN
    RAISE EXCEPTION 'delivery start event reason mismatch'
      USING ERRCODE='23514';
  ELSIF NEW.to_state='CONFIRMED' AND NEW.reason_code<>'PROVIDER_CONFIRMED' THEN
    RAISE EXCEPTION 'delivery confirmed event reason mismatch'
      USING ERRCODE='23514';
  ELSIF NEW.to_state IN ('AMBIGUOUS','FAILED') AND
        NEW.reason_code IS DISTINCT FROM attempt_outcome_code THEN
    RAISE EXCEPTION 'delivery outcome event reason mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_event_insert_guard
  ON facturations_delivery_events;
CREATE TRIGGER facturations_delivery_event_insert_guard
  BEFORE INSERT ON facturations_delivery_events
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_delivery_event_insert();

CREATE OR REPLACE FUNCTION facturations_require_delivery_attempt_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_to_state text;
BEGIN
  SELECT to_state
    INTO latest_to_state
    FROM facturations_delivery_events
   WHERE business_id=NEW.business_id
     AND attempt_id=NEW.id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND OR latest_to_state<>NEW.state THEN
    RAISE EXCEPTION 'delivery attempt transition ledger required'
      USING ERRCODE='23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_attempt_ledger_required
  ON facturations_delivery_attempts;
CREATE CONSTRAINT TRIGGER facturations_delivery_attempt_ledger_required
  AFTER INSERT OR UPDATE ON facturations_delivery_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION facturations_require_delivery_attempt_ledger();

COMMIT;
