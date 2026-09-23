-- Apply ONLY to the dedicated Facturations database, after migrations 001-012.
-- Exact Wave mapping snapshot only. This migration performs no network request.
BEGIN;
CREATE TABLE IF NOT EXISTS facturations_wave_issuance_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  authorization_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  wave_business_id text NOT NULL CHECK (length(wave_business_id) BETWEEN 1 AND 512),
  wave_customer_id text NOT NULL CHECK (length(wave_customer_id) BETWEEN 1 AND 512),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, authorization_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, authorization_id)
    REFERENCES facturations_issuance_authorizations(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS facturations_wave_line_mappings (
  business_id text NOT NULL,
  mapping_id uuid NOT NULL,
  line_index integer NOT NULL CHECK (line_index BETWEEN 0 AND 999),
  wave_product_id text NOT NULL CHECK (length(wave_product_id) BETWEEN 1 AND 512),
  PRIMARY KEY (business_id,mapping_id,line_index),
  FOREIGN KEY (business_id,mapping_id)
    REFERENCES facturations_wave_issuance_mappings(business_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS facturations_wave_tax_mappings (
  business_id text NOT NULL,
  mapping_id uuid NOT NULL,
  tax_code text NOT NULL CHECK (length(tax_code) BETWEEN 1 AND 32),
  wave_sales_tax_id text NOT NULL CHECK (length(wave_sales_tax_id) BETWEEN 1 AND 512),
  rate_milli_percent integer NOT NULL CHECK (rate_milli_percent BETWEEN 0 AND 100000),
  PRIMARY KEY (business_id,mapping_id,tax_code),
  FOREIGN KEY (business_id,mapping_id)
    REFERENCES facturations_wave_issuance_mappings(business_id,id) ON DELETE RESTRICT
);
COMMIT;
