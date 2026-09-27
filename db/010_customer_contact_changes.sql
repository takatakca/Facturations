-- Apply ONLY to the dedicated Facturations database, after migrations 001–009.
-- Never run against another TAKATAK database.
BEGIN;
ALTER TABLE invoice_customers
  ADD COLUMN IF NOT EXISTS contact_revision integer NOT NULL DEFAULT 1
  CHECK (contact_revision BETWEEN 1 AND 2147483647);
CREATE TABLE IF NOT EXISTS facturations_customer_contact_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id text NOT NULL,
  customer_id uuid NOT NULL,
  changed_by uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  contact_revision integer NOT NULL CHECK (contact_revision BETWEEN 1 AND 2147483647),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id, contact_revision),
  FOREIGN KEY (business_id, customer_id) REFERENCES invoice_customers(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, changed_by) REFERENCES facturations_staff_users(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS facturations_customer_contact_events_tenant_idx
  ON facturations_customer_contact_events (business_id, customer_id, occurred_at DESC);
COMMIT;
