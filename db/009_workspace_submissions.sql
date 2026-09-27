-- Dedicated Facturations database only, after migrations 001–008. Never run on TAKATAK production.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_workspace_submissions (
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  draft_id uuid NOT NULL,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, workspace_id),
  UNIQUE (business_id, draft_id),
  FOREIGN KEY (business_id, workspace_id)
    REFERENCES facturations_draft_workspaces(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, submitted_by)
    REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION facturations_reject_submission_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workspace submission mapping is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER facturations_submissions_append_only
  BEFORE UPDATE OR DELETE ON facturations_workspace_submissions
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_submission_mutation();

-- Defense-in-depth: any direct SQL update is also refused after submission.
-- A concurrent submission holds the workspace row lock until this mapping commits.
CREATE OR REPLACE FUNCTION facturations_reject_submitted_workspace_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM facturations_workspace_submissions s
             WHERE s.business_id=OLD.business_id AND s.workspace_id=OLD.id) THEN
    RAISE EXCEPTION 'submitted workspace is frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER facturations_workspace_frozen_after_submission
  BEFORE UPDATE ON facturations_draft_workspaces
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_submitted_workspace_mutation();
COMMIT;
