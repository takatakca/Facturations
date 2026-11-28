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

-- Stripe reversals (refunds, chargebacks) can arrive before their payment
-- is recorded, e.g. while a payment webhook is still being retried. They are
-- kept here, verified and append-only, and applied as soon as the payment for
-- the same PaymentIntent is recorded. Reversals of payments that never
-- become Facturations payments (other products on the same Stripe account)
-- simply stay unmatched. No card data, no customer data.
CREATE TABLE IF NOT EXISTS facturations_stripe_pending_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  reversal_kind text NOT NULL CHECK (
    reversal_kind IN ('REFUND_ISSUED','REFUND_REVERSED','DISPUTE_WITHDRAWN','DISPUTE_REINSTATED')
  ),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^(re|pyr|dp)_[A-Za-z0-9]{6,200}(:[a-z]+)?$'),
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]{6,200}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL CHECK (currency = 'CAD'),
  occurred_at timestamptz NOT NULL,
  webhook_body_sha256 text NOT NULL CHECK (webhook_body_sha256 ~ '^[a-f0-9]{64}$'),
  verification_scheme text NOT NULL CHECK (verification_scheme = 'STRIPE_SIGNATURE_V1'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS facturations_stripe_pending_reversals_intent_idx
  ON facturations_stripe_pending_reversals (business_id, payment_intent_id, occurred_at);

CREATE OR REPLACE FUNCTION facturations_reject_pending_reversal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pending Stripe reversals are append only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_stripe_pending_reversals_append_only
  ON facturations_stripe_pending_reversals;
CREATE TRIGGER facturations_stripe_pending_reversals_append_only
  BEFORE UPDATE OR DELETE ON facturations_stripe_pending_reversals
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_pending_reversal_mutation();

COMMIT;
