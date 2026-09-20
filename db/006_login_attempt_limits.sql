-- Apply ONLY to the independent GROUPE TAKATAK Facturations database.
-- Never apply to an existing TAKATAK production database.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_login_attempt_limits (
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  identity_hash bytea NOT NULL CHECK (octet_length(identity_hash) = 32),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  blocked_until timestamptz,
  PRIMARY KEY (business_id, identity_hash)
);
-- Retention: delete expired rows with a separately authorized maintenance job.
-- Never expose this table or the hash to browser clients.
COMMIT;
