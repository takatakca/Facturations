-- Apply ONLY to the dedicated Facturations database, after migrations 001-011.
-- Provider execution state only. This migration does not call Wave or issue invoices.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_provider_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'WAVE'),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','IN_PROGRESS','AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL','CONFIRMED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  provider_invoice_id text,
  official_invoice_number text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  reconciled_at timestamptz,
  UNIQUE (business_id, authorization_id),
  UNIQUE (business_id, operation_key),
  UNIQUE (business_id, provider, provider_invoice_id),
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  CHECK (provider_invoice_id IS NULL OR length(provider_invoice_id) BETWEEN 1 AND 512),
  CHECK (official_invoice_number IS NULL OR length(official_invoice_number) BETWEEN 1 AND 160),
  CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 160),
  CHECK ((state = 'CONFIRMED') = (provider_invoice_id IS NOT NULL AND official_invoice_number IS NOT NULL)),
  CHECK (state <> 'CONFIRMED' OR error_code IS NULL)
);
CREATE INDEX IF NOT EXISTS facturations_provider_executions_state_idx
  ON facturations_provider_executions (business_id,state,created_at DESC);
COMMIT;
