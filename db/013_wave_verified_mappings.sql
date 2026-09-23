-- Apply ONLY to the dedicated Facturations database after migrations 001-012.
-- Stores manually verified Wave identifiers. Performs no provider/network operation.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_wave_customer_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  customer_id uuid NOT NULL,
  wave_customer_id text NOT NULL CHECK (length(wave_customer_id) BETWEEN 1 AND 512),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id),
  UNIQUE (business_id, wave_customer_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id)
    REFERENCES invoice_customers(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_wave_tax_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  tax_code text NOT NULL CHECK (tax_code ~ '^[A-Z0-9_-]{1,20}$'),
  rate_milli_percent integer NOT NULL CHECK (rate_milli_percent BETWEEN 0 AND 100000),
  wave_sales_tax_id text NOT NULL CHECK (length(wave_sales_tax_id) BETWEEN 1 AND 512),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, tax_code),
  UNIQUE (business_id, wave_sales_tax_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_wave_draft_line_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  draft_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  line_index integer NOT NULL CHECK (line_index BETWEEN 0 AND 49),
  wave_product_id text NOT NULL CHECK (length(wave_product_id) BETWEEN 1 AND 512),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, draft_id, line_index),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, draft_id)
    REFERENCES invoice_drafts(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_wave_line_mappings_draft_idx
  ON facturations_wave_draft_line_mappings (business_id,draft_id,line_index);

CREATE TABLE IF NOT EXISTS facturations_wave_mapping_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  mapping_type text NOT NULL CHECK (mapping_type IN ('CUSTOMER','TAX','DRAFT_LINE')),
  mapping_id uuid NOT NULL,
  verified_by uuid NOT NULL,
  action text NOT NULL CHECK (action = 'VERIFIED'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_wave_mapping_events_idx
  ON facturations_wave_mapping_events (business_id,mapping_type,mapping_id,occurred_at,id);

CREATE OR REPLACE FUNCTION facturations_reject_wave_mapping_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Wave mappings are immutable; create a reviewed replacement workflow'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_wave_customer_mappings_append_only
  ON facturations_wave_customer_mappings;
CREATE TRIGGER facturations_wave_customer_mappings_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_customer_mappings
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_mapping_mutation();

DROP TRIGGER IF EXISTS facturations_wave_tax_mappings_append_only
  ON facturations_wave_tax_mappings;
CREATE TRIGGER facturations_wave_tax_mappings_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_tax_mappings
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_mapping_mutation();

DROP TRIGGER IF EXISTS facturations_wave_draft_line_mappings_append_only
  ON facturations_wave_draft_line_mappings;
CREATE TRIGGER facturations_wave_draft_line_mappings_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_draft_line_mappings
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_mapping_mutation();

CREATE OR REPLACE FUNCTION facturations_reject_wave_mapping_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Wave mapping events are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS facturations_wave_mapping_events_append_only
  ON facturations_wave_mapping_events;
CREATE TRIGGER facturations_wave_mapping_events_append_only
  BEFORE UPDATE OR DELETE ON facturations_wave_mapping_events
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_wave_mapping_event_mutation();

COMMIT;
