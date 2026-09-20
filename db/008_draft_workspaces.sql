-- Run ONLY against a NEW dedicated Facturations PostgreSQL database after 001–007.
-- Work-in-progress content is NOT an approved/issued invoice. Never mutate invoice_drafts snapshots.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_draft_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  owner_staff_id uuid NOT NULL,
  creation_key text NOT NULL CHECK (creation_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 32768),
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, owner_staff_id, creation_key),
  FOREIGN KEY (business_id, owner_staff_id)
    REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS facturations_draft_workspace_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  saved_by uuid NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 32768),
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, workspace_id, revision),
  FOREIGN KEY (business_id, workspace_id)
    REFERENCES facturations_draft_workspaces(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, saved_by)
    REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_draft_workspaces_owner_updated_idx
  ON facturations_draft_workspaces (business_id, owner_staff_id, updated_at DESC);

CREATE OR REPLACE FUNCTION facturations_protect_workspace_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'draft workspaces cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.owner_staff_id IS DISTINCT FROM OLD.owner_staff_id
     OR NEW.creation_key IS DISTINCT FROM OLD.creation_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'draft workspace identity/revision cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER facturations_workspace_protect_identity
  BEFORE UPDATE OR DELETE ON facturations_draft_workspaces
  FOR EACH ROW EXECUTE FUNCTION facturations_protect_workspace_identity();

CREATE OR REPLACE FUNCTION facturations_reject_workspace_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'draft workspace history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER facturations_workspace_history_append_only
  BEFORE UPDATE OR DELETE ON facturations_draft_workspace_revisions
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_workspace_history_mutation();

-- At commit, the current workspace must have a matching immutable revision.
CREATE OR REPLACE FUNCTION facturations_require_workspace_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM facturations_draft_workspace_revisions r
    WHERE r.business_id=NEW.business_id AND r.workspace_id=NEW.id
      AND r.revision=NEW.revision AND r.content=NEW.content
  ) THEN
    RAISE EXCEPTION 'draft workspace revision record required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER facturations_workspace_has_revision
  AFTER INSERT OR UPDATE ON facturations_draft_workspaces
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION facturations_require_workspace_revision();
COMMIT;
