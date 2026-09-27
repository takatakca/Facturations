-- Apply ONLY to the dedicated Facturations database, after migrations 001-015.
-- Binds one immutable verified issuer profile to one issued invoice, then archives
-- an issuer-qualified PDF derived from that exact binding.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_invoice_issuer_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  issued_invoice_id uuid NOT NULL,
  issuer_profile_id uuid NOT NULL,
  issuer_profile_hash text NOT NULL CHECK (issuer_profile_hash ~ '^[a-f0-9]{64}$'),
  issuer_profile_version integer NOT NULL CHECK (issuer_profile_version BETWEEN 1 AND 1000000),
  bound_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation = 'BIND_VERIFIED_ISSUER_TO_INVOICE'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, issued_invoice_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issuer_profile_id)
    REFERENCES facturations_issuer_profiles(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, bound_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_invoice_issuer_bindings_profile_idx
  ON facturations_invoice_issuer_bindings (business_id, issuer_profile_id);

CREATE TABLE IF NOT EXISTS facturations_qualified_invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  binding_id uuid NOT NULL,
  issued_invoice_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  source_document_sha256 text NOT NULL CHECK (source_document_sha256 ~ '^[a-f0-9]{64}$'),
  issuer_profile_id uuid NOT NULL,
  issuer_profile_hash text NOT NULL CHECK (issuer_profile_hash ~ '^[a-f0-9]{64}$'),
  issuer_profile_version integer NOT NULL CHECK (issuer_profile_version BETWEEN 1 AND 1000000),
  document_kind text NOT NULL DEFAULT 'QUALIFIED_INVOICE_PDF'
    CHECK (document_kind = 'QUALIFIED_INVOICE_PDF'),
  render_version text NOT NULL CHECK (length(render_version) BETWEEN 1 AND 80),
  content_type text NOT NULL DEFAULT 'application/pdf'
    CHECK (content_type = 'application/pdf'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 100 AND 2097152),
  pdf_bytes bytea NOT NULL,
  delivery_state text NOT NULL DEFAULT 'NOT_AUTHORIZED'
    CHECK (delivery_state = 'NOT_AUTHORIZED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, binding_id),
  UNIQUE (business_id, issued_invoice_id),
  UNIQUE (business_id, content_sha256),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, binding_id)
    REFERENCES facturations_invoice_issuer_bindings(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, source_document_id)
    REFERENCES facturations_issued_invoice_documents(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, issuer_profile_id)
    REFERENCES facturations_issuer_profiles(business_id,id) ON DELETE RESTRICT,
  CHECK (octet_length(pdf_bytes) = byte_length)
);

CREATE INDEX IF NOT EXISTS facturations_qualified_invoice_documents_created_idx
  ON facturations_qualified_invoice_documents (business_id, created_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_invoice_issuer_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice issuer bindings are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_invoice_issuer_bindings_append_only
  ON facturations_invoice_issuer_bindings;
CREATE TRIGGER facturations_invoice_issuer_bindings_append_only
  BEFORE UPDATE OR DELETE ON facturations_invoice_issuer_bindings
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_invoice_issuer_binding_mutation();

CREATE OR REPLACE FUNCTION facturations_reject_qualified_invoice_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'qualified invoice documents are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_qualified_invoice_documents_append_only
  ON facturations_qualified_invoice_documents;
CREATE TRIGGER facturations_qualified_invoice_documents_append_only
  BEFORE UPDATE OR DELETE ON facturations_qualified_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_qualified_invoice_document_mutation();

COMMIT;
