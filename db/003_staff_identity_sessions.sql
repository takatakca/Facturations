-- Apply only to a NEW dedicated Facturations database, after 001 and 002.
-- No existing GROUPE TAKATAK production database may be used.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  email_normalized text NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(email_normalized)),
  role text NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64),
  email_verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, email_normalized),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS facturations_staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT facturations_session_expires_after_create CHECK (expires_at > created_at),
  FOREIGN KEY (business_id, user_id) REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_staff_sessions_user_idx
  ON facturations_staff_sessions (business_id, user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS facturations_staff_sessions_expiry_idx
  ON facturations_staff_sessions (expires_at) WHERE revoked_at IS NULL;
COMMIT;
