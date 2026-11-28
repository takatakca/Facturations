-- Apply ONLY to the dedicated Facturations database, after migrations 001-035.
-- Binds every delivery authorization to the exact qualified PDF belonging to the same issued invoice.
-- This migration sends no email and performs no provider request.
BEGIN;

CREATE UNIQUE INDEX facturations_qualified_invoice_documents_delivery_auth_source_idx
  ON facturations_qualified_invoice_documents
     (business_id,issued_invoice_id,id,content_sha256);

ALTER TABLE facturations_delivery_authorizations
  ADD CONSTRAINT facturations_delivery_authorization_document_invoice_hash_fk
  FOREIGN KEY (
    business_id,
    issued_invoice_id,
    qualified_document_id,
    qualified_document_sha256
  )
  REFERENCES facturations_qualified_invoice_documents
    (business_id,issued_invoice_id,id,content_sha256)
  ON DELETE RESTRICT;

COMMIT;
