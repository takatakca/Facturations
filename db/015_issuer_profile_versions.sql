-- Apply ONLY to the dedicated Facturations database, after migrations 001-014.
-- Stores versioned issuer identity/fiscal data and a separate OWNER verification event.
-- No real issuer data is seeded by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_issuer_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  version_number integer NOT NULL CHECK (version_number >= 1),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  trade_name text CHECK (trade_name IS NULL OR length(trade_name) BETWEEN 1 AND 200),
  address_line1 text NOT NULL CHECK (length(address_line1) BETWEEN 1 AND 200),
  address_line2 text CHECK (address_line2 IS NULL OR length(address_line2) BETWEEN 1 AND 200),
  city text NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
  postal_code text NOT NULL CHECK (length(postal_code) BETWEEN 1 AND 24),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  phone text CHECK (phone IS NULL OR length(phone) BETWEEN 3 AND 40),
  business_registration_number text CHECK (
    business_registration_number IS NULL OR length(business_registration_number) BETWEEN 1 AND 80
  ),
  tax_identifiers jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(tax_identifiers) = 'object')
    CHECK (octet_length(tax_identifiers::text) <= 4096),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, version_number),
  UNIQUE (business_id, profile_hash),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, created_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facturations_issuer_profile_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  profile_version_id uuid NOT NULL,
  verified_by uuid NOT NULL,
  confirmation text NOT NULL CHECK (confirmation = 'VERIFY_ISSUER_PROFILE_FOR_INVOICING'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, profile_version_id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, profile_version_id)
    REFERENCES facturations_issuer_profile_versions(business_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_issuer_profiles_latest_idx
  ON facturations_issuer_profile_versions (business_id, version_number DESC);
CREATE INDEX IF NOT EXISTS facturations_issuer_profile_verifications_latest_idx
  ON facturations_issuer_profile_verifications (business_id, verified_at DESC);

CREATE OR REPLACE FUNCTION facturations_reject_issuer_profile_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issuer profile records are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_issuer_profile_versions_append_only
  ON facturations_issuer_profile_versions;
CREATE TRIGGER facturations_issuer_profile_versions_append_only
  BEFORE UPDATE OR DELETE ON facturations_issuer_profile_versions
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issuer_profile_mutation();

DROP TRIGGER IF EXISTS facturations_issuer_profile_verifications_append_only
  ON facturations_issuer_profile_verifications;
CREATE TRIGGER facturations_issuer_profile_verifications_append_only
  BEFORE UPDATE OR DELETE ON facturations_issuer_profile_verifications
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issuer_profile_mutation();

COMMIT;
