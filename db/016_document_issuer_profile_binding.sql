-- Apply ONLY to the dedicated Facturations database, after migrations 001-015.
-- Binds an immutable verified issuer-profile snapshot to an immutable invoice PDF archive.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_issued_invoice_document_issuer_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  document_id uuid NOT NULL,
  issuer_profile_version_id uuid NOT NULL,
  issuer_profile_hash text NOT NULL CHECK (issuer_profile_hash ~ '^[a-f0-9]{64}$'),
  issuer_profile_snapshot jsonb NOT NULL CHECK (jsonb_typeof(issuer_profile_snapshot) = 'object'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, document_id)
    REFERENCES facturations_issued_invoice_documents(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issuer_profile_version_id)
    REFERENCES facturations_issuer_profile_versions(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_document_issuer_profile_idx
  ON facturations_issued_invoice_document_issuer_bindings
  (business_id, issuer_profile_version_id, bound_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_document_issuer_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document issuer bindings are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_document_issuer_bindings_append_only
  ON facturations_issued_invoice_document_issuer_bindings;
CREATE TRIGGER facturations_document_issuer_bindings_append_only
  BEFORE UPDATE OR DELETE ON facturations_issued_invoice_document_issuer_bindings
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_document_issuer_binding_mutation();

COMMIT;
