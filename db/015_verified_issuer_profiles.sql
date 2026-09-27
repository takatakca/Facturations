-- Apply ONLY to the dedicated Facturations database, after migrations 001-014.
-- Stores append-only, OWNER-verified legal/fiscal issuer profiles.
-- No profile data is inferred from environment variables or external providers.
BEGIN;

CREATE TABLE IF NOT EXISTS facturations_issuer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text NOT NULL CHECK (length(business_id) BETWEEN 1 AND 200),
  profile_version integer NOT NULL CHECK (profile_version BETWEEN 1 AND 1000000),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  address_lines jsonb NOT NULL CHECK (
    jsonb_typeof(address_lines) = 'array' AND
    jsonb_array_length(address_lines) BETWEEN 1 AND 3
  ),
  city text NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
  postal_code text NOT NULL CHECK (length(postal_code) BETWEEN 1 AND 32),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  contact_email text,
  contact_phone text,
  tax_registrations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(tax_registrations) = 'array' AND jsonb_array_length(tax_registrations) <= 10),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  verification_method text NOT NULL CHECK (verification_method = 'HUMAN_DOCUMENT_REVIEW'),
  verification_reference text NOT NULL CHECK (length(verification_reference) BETWEEN 1 AND 200),
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'VERIFIED' CHECK (state = 'VERIFIED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, profile_version),
  UNIQUE (business_id, profile_hash),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, verified_by)
    REFERENCES facturations_staff_users(business_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS facturations_issuer_profiles_latest_idx
  ON facturations_issuer_profiles (business_id, profile_version DESC);

CREATE OR REPLACE FUNCTION facturations_reject_issuer_profile_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issuer profiles are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS facturations_issuer_profiles_append_only
  ON facturations_issuer_profiles;
CREATE TRIGGER facturations_issuer_profiles_append_only
  BEFORE UPDATE OR DELETE ON facturations_issuer_profiles
  FOR EACH ROW EXECUTE FUNCTION facturations_reject_issuer_profile_mutation();

COMMIT;
