-- Apply ONLY to the dedicated Facturations database, after migrations 001-040.
-- Enforces end-to-end provenance for immutable issued-invoice materialization.
-- This migration performs no Wave/API/network request and sends no email.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_validate_issued_invoice_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_authorization_id uuid;
  source_draft_id uuid;
  source_provider text;
  source_state text;
  source_provider_invoice_id text;
  source_provider_invoice_number text;
  source_finished_at timestamptz;
  authorization_request_hash text;
  authorization_expected_total bigint;
  authorization_expected_email text;
  authorization_provider text;
  authorization_state text;
  draft_request_hash text;
  draft_snapshot jsonb;
  draft_status text;
  latest_event_to_state text;
  latest_event_reason text;
BEGIN
  SELECT
      t.authorization_id,
      t.draft_id,
      t.provider,
      t.state,
      t.provider_invoice_id,
      t.provider_invoice_number,
      t.finished_at,
      a.request_hash,
      a.expected_total_cents,
      a.expected_customer_email,
      a.provider,
      a.state,
      d.request_hash,
      d.snapshot,
      d.status
    INTO
      source_authorization_id,
      source_draft_id,
      source_provider,
      source_state,
      source_provider_invoice_id,
      source_provider_invoice_number,
      source_finished_at,
      authorization_request_hash,
      authorization_expected_total,
      authorization_expected_email,
      authorization_provider,
      authorization_state,
      draft_request_hash,
      draft_snapshot,
      draft_status
    FROM facturations_provider_issuance_attempts t
    JOIN facturations_issuance_authorizations a
      ON a.business_id=t.business_id
     AND a.id=t.authorization_id
     AND a.draft_id=t.draft_id
     AND a.provider=t.provider
    JOIN invoice_drafts d
      ON d.business_id=t.business_id
     AND d.id=t.draft_id
   WHERE t.business_id=NEW.business_id
     AND t.id=NEW.attempt_id
   FOR KEY SHARE OF t,a,d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issued invoice provenance source not found'
      USING ERRCODE='23514';
  END IF;

  SELECT to_state,reason_code
    INTO latest_event_to_state,latest_event_reason
    FROM facturations_provider_issuance_events
   WHERE business_id=NEW.business_id
     AND attempt_id=NEW.attempt_id
   ORDER BY id DESC
   LIMIT 1;

  IF source_state<>'CONFIRMED' OR
     source_finished_at IS NULL OR
     source_provider_invoice_id IS NULL OR
     source_provider_invoice_number IS NULL OR
     authorization_state<>'AUTHORIZED_PENDING_PROVIDER' OR
     draft_status<>'DRAFT' OR
     source_provider<>authorization_provider OR
     authorization_request_hash<>draft_request_hash OR
     authorization_expected_total <>
       CASE
         WHEN jsonb_typeof(draft_snapshot->'totalCents')='number'
           THEN (draft_snapshot->>'totalCents')::bigint
         ELSE -1
       END OR
     authorization_expected_email <>
       lower(COALESCE(draft_snapshot#>>'{customer,email}','')) OR
     latest_event_to_state<>'CONFIRMED' OR
     latest_event_reason<>'PROVIDER_CONFIRMED' OR
     NEW.authorization_id<>source_authorization_id OR
     NEW.draft_id<>source_draft_id OR
     NEW.provider<>source_provider OR
     NEW.provider_invoice_id<>source_provider_invoice_id OR
     NEW.official_invoice_number<>source_provider_invoice_number OR
     NEW.request_hash<>draft_request_hash OR
     NEW.issued_snapshot IS DISTINCT FROM draft_snapshot OR
     date_trunc('milliseconds',NEW.provider_confirmed_at) <>
       date_trunc('milliseconds',source_finished_at) OR
     NEW.materialized_at<source_finished_at THEN
    RAISE EXCEPTION 'issued invoice provenance mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_issued_invoice_provenance_guard
  ON facturations_issued_invoices;
CREATE TRIGGER facturations_issued_invoice_provenance_guard
  BEFORE INSERT ON facturations_issued_invoices
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_issued_invoice_provenance();

COMMIT;
