-- Apply ONLY to the isolated Facturations database after migrations 001-027.
-- One-time integration token use for native write endpoints.
-- Raw JWTs and raw jti values are never stored; only SHA-256 digests are persisted.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_integration_token_uses (
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  jti_hash bytea NOT NULL CHECK (octet_length(jti_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, jti_hash)
);

CREATE INDEX IF NOT EXISTS facturations_integration_token_uses_expiry_idx
  ON facturations_integration_token_uses (expires_at);

COMMIT;
