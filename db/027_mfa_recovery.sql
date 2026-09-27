-- Apply ONLY to the dedicated Facturations database, after migrations 001-026.
-- Trusted operator MFA recovery ceremony. No public/browser route may issue these tokens.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_mfa_recovery_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  verification_method text NOT NULL
    CHECK (verification_method = 'HUMAN_OUT_OF_BAND'),
  verification_reference text NOT NULL
    CHECK (length(verification_reference) BETWEEN 3 AND 200),
  confirmation text NOT NULL
    CHECK (confirmation = 'AUTHORIZE_OWNER_MFA_RECOVERY'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at),
  UNIQUE (business_id,id),
  FOREIGN KEY (business_id,user_id)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_mfa_recovery_user_idx
  ON facturations_mfa_recovery_authorizations
  (business_id,user_id,issued_at DESC);

CREATE TABLE IF NOT EXISTS facturations_mfa_recovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  authorization_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ISSUED','CONSUMED','REVOKED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,authorization_id,event_type),
  FOREIGN KEY (business_id,authorization_id)
    REFERENCES facturations_mfa_recovery_authorizations(business_id,id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS facturations_one_terminal_mfa_recovery_event
  ON facturations_mfa_recovery_events(business_id,authorization_id)
  WHERE event_type IN ('CONSUMED','REVOKED');

CREATE INDEX IF NOT EXISTS facturations_mfa_recovery_events_idx
  ON facturations_mfa_recovery_events
  (business_id,authorization_id,occurred_at,id);

CREATE OR REPLACE FUNCTION facturations_reject_mfa_recovery_authorization_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mfa recovery authorizations are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_mfa_recovery_authorizations_append_only
  ON facturations_mfa_recovery_authorizations;
CREATE TRIGGER facturations_mfa_recovery_authorizations_append_only
  BEFORE UPDATE OR DELETE ON facturations_mfa_recovery_authorizations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_mfa_recovery_authorization_mutation();

CREATE OR REPLACE FUNCTION facturations_reject_mfa_recovery_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mfa recovery events are append only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_mfa_recovery_events_append_only
  ON facturations_mfa_recovery_events;
CREATE TRIGGER facturations_mfa_recovery_events_append_only
  BEFORE UPDATE OR DELETE ON facturations_mfa_recovery_events
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_mfa_recovery_event_mutation();

COMMIT;
