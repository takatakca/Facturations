-- Apply ONLY to the dedicated Facturations database, after migrations 001-024.
-- Client identity is separate from staff identity and access is granted only by explicit
-- membership to an invoice_customer in the same business.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_client_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  email_normalized text NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 254
    AND email_normalized = lower(email_normalized)
  ),
  password_salt bytea,
  password_hash bytea,
  email_verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,email_normalized),
  UNIQUE (business_id,id),
  CHECK (
    (password_salt IS NULL AND password_hash IS NULL AND email_verified_at IS NULL)
    OR
    (octet_length(password_salt)=16 AND octet_length(password_hash)=64 AND email_verified_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS facturations_client_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'BILLING_VIEWER' CHECK (role='BILLING_VIEWER'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,user_id,customer_id),
  UNIQUE (business_id,id),
  FOREIGN KEY (business_id,user_id)
    REFERENCES facturations_client_users(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_client_memberships_user_idx
  ON facturations_client_memberships (business_id,user_id,created_at,id);
CREATE INDEX IF NOT EXISTS facturations_client_memberships_customer_idx
  ON facturations_client_memberships (business_id,customer_id,created_at,id);

CREATE TABLE IF NOT EXISTS facturations_client_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  membership_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  FOREIGN KEY (business_id,membership_id)
    REFERENCES facturations_client_memberships(business_id,id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS facturations_one_active_client_invitation
  ON facturations_client_invitations(business_id,membership_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS facturations_client_invitation_expiry
  ON facturations_client_invitations(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS facturations_client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (business_id,user_id)
    REFERENCES facturations_client_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_client_sessions_user_idx
  ON facturations_client_sessions (business_id,user_id,expires_at DESC);
CREATE INDEX IF NOT EXISTS facturations_client_sessions_expiry_idx
  ON facturations_client_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS facturations_client_login_attempt_limits (
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  identity_hash bytea NOT NULL CHECK (octet_length(identity_hash)=32),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  blocked_until timestamptz,
  PRIMARY KEY (business_id,identity_hash)
);

COMMIT;
