-- Apply ONLY to the independent GROUPE TAKATAK Facturations database after 006.
-- Never apply to an existing TAKATAK production database.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_staff_totp (
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  secret_iv bytea NOT NULL CHECK (octet_length(secret_iv) = 12),
  secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) = 20),
  secret_tag bytea NOT NULL CHECK (octet_length(secret_tag) = 16),
  active boolean NOT NULL DEFAULT false,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  PRIMARY KEY (business_id, user_id),
  FOREIGN KEY (business_id, user_id) REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT,
  CONSTRAINT facturations_totp_activation_consistency CHECK (
    (active = false AND activated_at IS NULL AND last_used_step IS NULL) OR
    (active = true AND activated_at IS NOT NULL AND last_used_step IS NOT NULL AND last_used_step >= 0)
  )
);
-- Only trusted backend provisioning may read this table. Never expose TOTP material to clients.
COMMIT;
