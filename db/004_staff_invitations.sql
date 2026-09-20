-- Apply ONLY to a NEW dedicated Facturations database after migrations 001-003.
-- Never apply to existing GROUPE TAKATAK production databases.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  FOREIGN KEY (business_id, user_id)
    REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);

-- The same unverified staff member cannot have two concurrently redeemable links.
CREATE UNIQUE INDEX IF NOT EXISTS facturations_one_active_staff_invitation
  ON facturations_staff_invitations(business_id, user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS facturations_staff_invitation_expiry
  ON facturations_staff_invitations(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

COMMIT;
