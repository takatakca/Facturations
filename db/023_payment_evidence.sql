-- Apply ONLY to the dedicated Facturations database, after migrations 001-022.
-- Persists provider-neutral payment/refund evidence. Current code writes SYNTHETIC_TEST only.
-- This migration never charges, refunds or contacts a payment provider.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  issued_invoice_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (
    length(provider_key) BETWEEN 2 AND 64
    AND provider_key ~ '^[A-Z][A-Z0-9_]+$'
  ),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  provider_transaction_id text NOT NULL CHECK (length(provider_transaction_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN ('PAYMENT_RECEIVED','REFUND_ISSUED')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL CHECK (currency = 'CAD'),
  occurred_at timestamptz NOT NULL,
  source_mode text NOT NULL CHECK (source_mode IN ('SYNTHETIC_TEST','VERIFIED_PROVIDER_WEBHOOK')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider_key, provider_event_id),
  UNIQUE (business_id, evidence_hash),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, issued_invoice_id)
    REFERENCES facturations_issued_invoices(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_payment_evidence_invoice_idx
  ON facturations_payment_evidence
     (business_id,issued_invoice_id,occurred_at,id);

CREATE INDEX IF NOT EXISTS facturations_payment_evidence_transaction_idx
  ON facturations_payment_evidence
     (business_id,provider_key,provider_transaction_id,occurred_at,id);

CREATE OR REPLACE FUNCTION facturations_reject_payment_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment evidence is append only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_payment_evidence_append_only
  ON facturations_payment_evidence;
CREATE TRIGGER facturations_payment_evidence_append_only
  BEFORE UPDATE OR DELETE ON facturations_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_payment_evidence_mutation();

COMMIT;
