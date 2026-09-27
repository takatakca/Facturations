-- Apply ONLY to the dedicated Facturations database, after migrations 001-025.
-- OWNER-controlled publication gate for one exact qualified PDF in the client portal.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_client_portal_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  issued_invoice_id uuid NOT NULL,
  qualified_document_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  qualified_document_sha256 text NOT NULL CHECK (qualified_document_sha256 ~ '^[a-f0-9]{64}$'),
  authorized_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation='AUTHORIZE_CLIENT_PORTAL_PUBLICATION'),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,issued_invoice_id),
  UNIQUE (business_id,qualified_document_id),
  UNIQUE (business_id,id),
  FOREIGN KEY (business_id,issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,qualified_document_id)
    REFERENCES facturations_qualified_invoice_documents(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,authorized_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_client_portal_publication_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  publication_id uuid NOT NULL,
  revoked_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation='REVOKE_CLIENT_PORTAL_PUBLICATION'),
  reason_code text NOT NULL CHECK (
    length(reason_code) BETWEEN 1 AND 64
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,publication_id),
  UNIQUE (business_id,id),
  FOREIGN KEY (business_id,publication_id)
    REFERENCES facturations_client_portal_publications(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id,revoked_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_client_portal_publications_customer_idx
  ON facturations_client_portal_publications
     (business_id,customer_id,authorized_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_client_portal_publication_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'client portal publication records are immutable' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_client_portal_publications_append_only
  ON facturations_client_portal_publications;
CREATE TRIGGER facturations_client_portal_publications_append_only
  BEFORE UPDATE OR DELETE ON facturations_client_portal_publications
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_client_portal_publication_mutation();

DROP TRIGGER IF EXISTS facturations_client_portal_publication_revocations_append_only
  ON facturations_client_portal_publication_revocations;
CREATE TRIGGER facturations_client_portal_publication_revocations_append_only
  BEFORE UPDATE OR DELETE ON facturations_client_portal_publication_revocations
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_client_portal_publication_mutation();

COMMIT;
