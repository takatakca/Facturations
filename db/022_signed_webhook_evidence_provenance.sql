-- Apply ONLY to the dedicated Facturations database, after migrations 001-021.
-- Extends provider evidence provenance for verified signed webhooks.
BEGIN;

ALTER TABLE facturations_email_provider_evidence
  ADD COLUMN IF NOT EXISTS webhook_body_sha256 text,
  ADD COLUMN IF NOT EXISTS verification_scheme text;

ALTER TABLE facturations_email_provider_evidence
  DROP CONSTRAINT IF EXISTS facturations_email_provider_evidence_source_provenance_check;

ALTER TABLE facturations_email_provider_evidence
  ADD CONSTRAINT facturations_email_provider_evidence_source_provenance_check
  CHECK (
    (source_mode = 'SYNTHETIC_TEST'
      AND webhook_body_sha256 IS NULL
      AND verification_scheme IS NULL)
    OR
    (source_mode = 'SIGNED_WEBHOOK'
      AND webhook_body_sha256 ~ '^[a-f0-9]{64}$'
      AND length(verification_scheme) BETWEEN 1 AND 120)
  );

COMMIT;
