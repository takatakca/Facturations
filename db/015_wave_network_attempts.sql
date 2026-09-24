-- Apply ONLY to the dedicated Facturations database, after migrations 001-014.
-- Records that a specific provider mutation attempt was started BEFORE network I/O.
-- No endpoint, token, request body or customer data is stored here.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_wave_network_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  execution_id uuid NOT NULL,
  execution_version integer NOT NULL CHECK (execution_version BETWEEN 1 AND 2147483647),
  operation text NOT NULL CHECK (operation IN ('CREATE_DRAFT','APPROVE_INVOICE')),
  started_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,execution_id,execution_version,operation),
  FOREIGN KEY (business_id,execution_id)
    REFERENCES facturations_provider_executions(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_wave_network_attempts_execution_idx
  ON facturations_wave_network_attempts
     (business_id,execution_id,execution_version,started_at);

CREATE OR REPLACE FUNCTION facturations_reject_wave_network_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'wave network attempts are immutable' USING ERRCODE = '23514';
END;
$;
DROP TRIGGER IF EXISTS facturations_wave_network_attempts_append_only
  ON facturations_wave_network_attempts;
CREATE TRIGGER facturations_wave_network_attempts_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_network_attempts
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_network_attempt_mutation();
COMMIT;
