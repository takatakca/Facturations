-- Apply ONLY to the dedicated Facturations database, after migrations 001-028.
-- Fail closed: this release has no signed payment-provider webhook ingestion path.
-- VERIFIED_PROVIDER_WEBHOOK must not be accepted until a future reviewed migration
-- adds explicit signature/provenance columns and a verified ingestion implementation.
BEGIN;

ALTER TABLE facturations_payment_evidence
  DROP CONSTRAINT IF EXISTS facturations_payment_evidence_source_mode_check;

ALTER TABLE facturations_payment_evidence
  ADD CONSTRAINT facturations_payment_evidence_source_mode_check
  CHECK (source_mode = 'SYNTHETIC_TEST');

COMMIT;
