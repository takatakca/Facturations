-- Apply ONLY to the dedicated Facturations database, after migrations 001-045.
-- Never execute this file against an existing TAKATAK production database.
--
-- Opens the reviewed path that migration 029 deliberately kept closed:
-- payment evidence may be VERIFIED_PROVIDER_WEBHOOK only when it comes from
-- Stripe, carries the SHA-256 of the exact signed raw webhook body and the
-- verification scheme STRIPE_SIGNATURE_V1. Synthetic evidence carries no
-- webhook provenance at all. Rows stay append-only (migration 023).
BEGIN;

ALTER TABLE facturations_payment_evidence
  ADD COLUMN IF NOT EXISTS webhook_body_sha256 text,
  ADD COLUMN IF NOT EXISTS verification_scheme text;

ALTER TABLE facturations_payment_evidence
  DROP CONSTRAINT IF EXISTS facturations_payment_evidence_source_mode_check;

ALTER TABLE facturations_payment_evidence
  DROP CONSTRAINT IF EXISTS facturations_payment_evidence_source_provenance_check;

ALTER TABLE facturations_payment_evidence
  ADD CONSTRAINT facturations_payment_evidence_source_provenance_check
  CHECK (
    (source_mode = 'SYNTHETIC_TEST'
      AND webhook_body_sha256 IS NULL
      AND verification_scheme IS NULL)
    OR
    (source_mode = 'VERIFIED_PROVIDER_WEBHOOK'
      AND provider_key = 'STRIPE'
      AND webhook_body_sha256 ~ '^[a-f0-9]{64}$'
      AND verification_scheme = 'STRIPE_SIGNATURE_V1')
  );

COMMIT;
