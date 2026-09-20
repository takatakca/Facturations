-- Run ONLY against a NEW dedicated Facturations PostgreSQL database.
-- Never execute this file against an existing TAKATAK production database.
-- Requires PostgreSQL 13+ (gen_random_uuid()).
BEGIN;
CREATE TABLE IF NOT EXISTS invoice_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, email_normalized),
  UNIQUE (business_id, id)
);
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 80),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status = 'DRAFT'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, idempotency_key),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES invoice_customers(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS invoice_drafts_business_created_idx ON invoice_drafts(business_id, created_at DESC);
CREATE TABLE IF NOT EXISTS invoice_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  draft_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('DRAFT_CREATED')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, draft_id) REFERENCES invoice_drafts(business_id, id) ON DELETE RESTRICT
);
-- Restricted database role must only have necessary privileges; never expose credentials in browser code.
COMMIT;
