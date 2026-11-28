-- Apply ONLY to the dedicated Facturations database, after migrations 001-031.
-- Binds each client-portal publication to a qualified PDF belonging to the same issued invoice.
BEGIN;

CREATE UNIQUE INDEX facturations_qualified_invoice_documents_invoice_id_idx
  ON facturations_qualified_invoice_documents
     (business_id,issued_invoice_id,id);

ALTER TABLE facturations_client_portal_publications
  ADD CONSTRAINT facturations_client_portal_publication_document_invoice_fk
  FOREIGN KEY (business_id,issued_invoice_id,qualified_document_id)
  REFERENCES facturations_qualified_invoice_documents
    (business_id,issued_invoice_id,id)
  ON DELETE RESTRICT;

COMMIT;
