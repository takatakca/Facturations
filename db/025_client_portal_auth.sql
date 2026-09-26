-- Apply ONLY to the dedicated Facturations database, after migrations 001-024.
-- Passwordless client portal identity foundation. No public HTTP route is created here.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_client_portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  email_normalized text NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 254
    AND email_normalized = lower(email_normalized)
  ),
  email_verified_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id),
  UNIQUE (business_id, email_normalized),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_client_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  issued_by uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  expected_email_normalized text NOT NULL CHECK (
    length(expected_email_normalized) BETWEEN 3 AND 254
    AND expected_email_normalized = lower(expected_email_normalized)
  ),
  purpose text NOT NULL DEFAULT 'SIGN_IN_OR_RECOVERY'
    CHECK (purpose='SIGN_IN_OR_RECOVERY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (business_id, customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issued_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_client_access_links_customer_idx
  ON facturations_client_access_links
     (business_id,customer_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS facturations_client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (business_id, customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_client_sessions_customer_idx
  ON facturations_client_sessions
     (business_id,customer_id,expires_at DESC);

COMMIT;
