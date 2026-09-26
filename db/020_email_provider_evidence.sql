-- Apply ONLY to the dedicated Facturations database, after migrations 001-019.
-- Persists provider evidence events. Current code only writes SYNTHETIC_TEST events.
-- SIGNED_WEBHOOK is reserved for a future authenticated provider integration.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_email_provider_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  qualified_document_id uuid NOT NULL,
  qualified_document_sha256 text NOT NULL CHECK (qualified_document_sha256 ~ '^[a-f0-9]{64}$'),
  operation_key text NOT NULL CHECK (
    length(operation_key) BETWEEN 24 AND 120
    AND operation_key ~ '^[A-Za-z0-9_-]+$'
  ),
  provider_key text NOT NULL CHECK (
    length(provider_key) BETWEEN 2 AND 64
    AND provider_key ~ '^[A-Z][A-Z0-9_]+$'
  ),
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 512),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN ('DELIVERED','BOUNCED','COMPLAINT')),
  occurred_at timestamptz NOT NULL,
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  source_mode text NOT NULL CHECK (source_mode IN ('SYNTHETIC_TEST','SIGNED_WEBHOOK')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider_key, provider_event_id),
  UNIQUE (business_id, evidence_hash),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, qualified_document_id)
    REFERENCES facturations_qualified_invoice_documents(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_email_provider_evidence_message_idx
  ON facturations_email_provider_evidence
     (business_id, provider_key, provider_message_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS facturations_email_provider_evidence_document_idx
  ON facturations_email_provider_evidence
     (business_id, qualified_document_id, occurred_at, id);

CREATE OR REPLACE FUNCTION facturations_reject_email_provider_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email provider evidence is append only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_email_provider_evidence_append_only
  ON facturations_email_provider_evidence;
CREATE TRIGGER facturations_email_provider_evidence_append_only
  BEFORE UPDATE OR DELETE ON facturations_email_provider_evidence
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_email_provider_evidence_mutation();

COMMIT;
