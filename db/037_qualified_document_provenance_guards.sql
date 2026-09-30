-- Apply ONLY to the dedicated Facturations database, after migrations 001-036.
-- Enforces issuer-binding and qualified-PDF provenance as composite PostgreSQL relationships.
-- This migration renders no PDF, sends no email and performs no provider request.
BEGIN;

CREATE UNIQUE INDEX facturations_issuer_profiles_provenance_idx
  ON facturations_issuer_profiles
     (business_id,id,profile_hash,profile_version);

ALTER TABLE facturations_invoice_issuer_bindings
  ADD CONSTRAINT facturations_invoice_issuer_binding_profile_provenance_fk
  FOREIGN KEY (
    business_id,
    issuer_profile_id,
    issuer_profile_hash,
    issuer_profile_version
  )
  REFERENCES facturations_issuer_profiles
    (business_id,id,profile_hash,profile_version)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX facturations_invoice_issuer_bindings_provenance_idx
  ON facturations_invoice_issuer_bindings
     (
       business_id,
       id,
       issued_invoice_id,
       issuer_profile_id,
       issuer_profile_hash,
       issuer_profile_version
     );

CREATE UNIQUE INDEX facturations_issued_invoice_documents_provenance_idx
  ON facturations_issued_invoice_documents
     (business_id,issued_invoice_id,id,content_sha256);

ALTER TABLE facturations_qualified_invoice_documents
  ADD CONSTRAINT facturations_qualified_document_binding_provenance_fk
  FOREIGN KEY (
    business_id,
    binding_id,
    issued_invoice_id,
    issuer_profile_id,
    issuer_profile_hash,
    issuer_profile_version
  )
  REFERENCES facturations_invoice_issuer_bindings
    (
      business_id,
      id,
      issued_invoice_id,
      issuer_profile_id,
      issuer_profile_hash,
      issuer_profile_version
    )
  ON DELETE RESTRICT;

ALTER TABLE facturations_qualified_invoice_documents
  ADD CONSTRAINT facturations_qualified_document_source_provenance_fk
  FOREIGN KEY (
    business_id,
    issued_invoice_id,
    source_document_id,
    source_document_sha256
  )
  REFERENCES facturations_issued_invoice_documents
    (business_id,issued_invoice_id,id,content_sha256)
  ON DELETE RESTRICT;

COMMIT;
