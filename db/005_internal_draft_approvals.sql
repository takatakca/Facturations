-- Apply ONLY to the new isolated Facturations database after migrations 001-004.
-- Internal owner review ONLY: approval is NOT invoice issuance, Wave sync, email or payment.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_draft_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  draft_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, draft_id),
  FOREIGN KEY (business_id, draft_id) REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, approved_by) REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_approvals_owner_idx
 ON facturations_draft_approvals (business_id,approved_by,approved_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'internal approvals are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS facturations_approvals_append_only ON facturations_draft_approvals;
CREATE TRIGGER facturations_approvals_append_only
 BEFORE UPDATE OR DELETE ON facturations_draft_approvals
 FOR EACH ROW EXECUTE FUNCTION facturations_reject_approval_mutation();
COMMIT;
