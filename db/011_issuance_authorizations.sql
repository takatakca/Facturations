-- Apply ONLY to the dedicated Facturations database, after migrations 001-010.
-- This records an OWNER authorization to proceed toward issuance; it does NOT issue, number,
-- sync, email, charge or otherwise contact an external provider.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_issuance_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  draft_id uuid NOT NULL,
  authorized_by uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_total_cents bigint NOT NULL CHECK (expected_total_cents BETWEEN 0 AND 1000000000000),
  expected_customer_email text NOT NULL CHECK (length(expected_customer_email) BETWEEN 3 AND 254),
  provider text NOT NULL CHECK (provider = 'WAVE'),
  state text NOT NULL DEFAULT 'AUTHORIZED_PENDING_PROVIDER'
    CHECK (state = 'AUTHORIZED_PENDING_PROVIDER'),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, draft_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, draft_id) REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, authorized_by) REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_issuance_authorizations_owner_idx
  ON facturations_issuance_authorizations (business_id, authorized_by, authorized_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_issuance_authorization_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issuance authorizations are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS facturations_issuance_authorizations_append_only
  ON facturations_issuance_authorizations;
CREATE TRIGGER facturations_issuance_authorizations_append_only
  BEFORE UPDATE OR DELETE ON facturations_issuance_authorizations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issuance_authorization_mutation();
COMMIT;
