-- Apply ONLY to the dedicated Facturations database, after migrations 001-029.
-- Prevents the same provider transaction/event type from being counted more than once.
-- This migration performs no network request and never charges or refunds a payment.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS facturations_payment_evidence_transaction_event_unique
  ON facturations_payment_evidence
     (business_id,provider_key,provider_transaction_id,event_type);

COMMIT;
