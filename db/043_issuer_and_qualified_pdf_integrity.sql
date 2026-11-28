-- Apply ONLY to the dedicated Facturations database, after migrations 001-042.
-- Finalizes issuer-profile and qualified-PDF integrity at the PostgreSQL boundary.
-- This migration performs no provider request, email delivery or payment action.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_compute_issuer_profile_hash(
  p_legal_name text,
  p_display_name text,
  p_address_lines jsonb,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country_code text,
  p_contact_email text,
  p_contact_phone text,
  p_tax_registrations jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  address_json text := '';
  tax_json text := '';
  canonical text;
  element jsonb;
  first_item boolean := true;
BEGIN
  IF jsonb_typeof(p_address_lines)<>'array'
     OR jsonb_array_length(p_address_lines) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'invalid issuer profile address structure'
      USING ERRCODE='23514';
  END IF;

  FOR element IN SELECT value FROM jsonb_array_elements(p_address_lines)
  LOOP
    IF jsonb_typeof(element)<>'string' THEN
      RAISE EXCEPTION 'invalid issuer profile address structure'
        USING ERRCODE='23514';
    END IF;
    IF NOT first_item THEN address_json := address_json || ','; END IF;
    address_json := address_json || to_json(element #>> '{}')::text;
    first_item := false;
  END LOOP;

  IF jsonb_typeof(p_tax_registrations)<>'array'
     OR jsonb_array_length(p_tax_registrations)>10 THEN
    RAISE EXCEPTION 'invalid issuer profile tax structure'
      USING ERRCODE='23514';
  END IF;

  first_item := true;
  FOR element IN SELECT value FROM jsonb_array_elements(p_tax_registrations)
  LOOP
    IF jsonb_typeof(element)<>'object'
       OR jsonb_typeof(element->'scheme')<>'string'
       OR jsonb_typeof(element->'registrationNumber')<>'string'
       OR length(element->>'scheme') NOT BETWEEN 1 AND 40
       OR length(element->>'registrationNumber') NOT BETWEEN 1 AND 80
       OR (element->>'scheme')<>upper(element->>'scheme') THEN
      RAISE EXCEPTION 'invalid issuer profile tax structure'
        USING ERRCODE='23514';
    END IF;
    IF NOT first_item THEN tax_json := tax_json || ','; END IF;
    tax_json := tax_json ||
      '{"scheme":'||to_json(element->>'scheme')::text||
      ',"registrationNumber":'||to_json(element->>'registrationNumber')::text||'}';
    first_item := false;
  END LOOP;

  canonical :=
    '{"legalName":'||to_json(p_legal_name)::text||
    ',"displayName":'||to_json(p_display_name)::text||
    ',"addressLines":['||address_json||']'||
    ',"city":'||to_json(p_city)::text||
    ',"region":'||to_json(p_region)::text||
    ',"postalCode":'||to_json(p_postal_code)::text||
    ',"countryCode":'||to_json(p_country_code)::text||
    ',"contactEmail":'||
      CASE WHEN p_contact_email IS NULL THEN 'null'
           ELSE to_json(p_contact_email)::text END||
    ',"contactPhone":'||
      CASE WHEN p_contact_phone IS NULL THEN 'null'
           ELSE to_json(p_contact_phone)::text END||
    ',"taxRegistrations":['||tax_json||']}';

  RETURN encode(
    sha256(
      convert_to('facturations-issuer-profile-v1','UTF8') ||
      decode('00','hex') ||
      convert_to(canonical,'UTF8')
    ),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION facturations_validate_issuer_profile_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_version integer;
  owner_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id,0));

  SELECT COALESCE(MAX(profile_version),0)::integer + 1
    INTO expected_version
    FROM facturations_issuer_profiles
   WHERE business_id=NEW.business_id;

  SELECT EXISTS (
    SELECT 1
      FROM facturations_staff_users u
     WHERE u.business_id=NEW.business_id
       AND u.id=NEW.verified_by
       AND u.role='OWNER'
       AND u.enabled
       AND u.email_verified_at IS NOT NULL
  ) INTO owner_ok;

  IF NEW.profile_version<>expected_version
     OR NOT owner_ok
     OR NEW.state<>'VERIFIED'
     OR NEW.verification_method<>'HUMAN_DOCUMENT_REVIEW'
     OR NEW.created_at<NEW.verified_at THEN
    RAISE EXCEPTION 'issuer profile integrity mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_issuer_profile_insert_integrity_guard
  ON facturations_issuer_profiles;
CREATE TRIGGER facturations_issuer_profile_insert_integrity_guard
  BEFORE INSERT ON facturations_issuer_profiles
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_issuer_profile_insert();

ALTER TABLE facturations_issuer_profiles
  ADD CONSTRAINT facturations_issuer_profile_hash_integrity_check
  CHECK (
    profile_hash = facturations_compute_issuer_profile_hash(
      legal_name,display_name,address_lines,city,region,postal_code,country_code,
      contact_email,contact_phone,tax_registrations
    )
  );

CREATE OR REPLACE FUNCTION facturations_validate_qualified_document_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding_bound_at timestamptz;
  source_created_at timestamptz;
  profile_verified_at timestamptz;
  invoice_materialized_at timestamptz;
  profile_tax_registrations jsonb;
  invoice_tax_total bigint;
BEGIN
  SELECT
      b.bound_at,
      d.created_at,
      p.verified_at,
      i.materialized_at,
      p.tax_registrations,
      CASE
        WHEN jsonb_typeof(i.issued_snapshot->'taxTotalCents')='number'
          THEN (i.issued_snapshot->>'taxTotalCents')::bigint
        ELSE -1
      END
    INTO
      binding_bound_at,
      source_created_at,
      profile_verified_at,
      invoice_materialized_at,
      profile_tax_registrations,
      invoice_tax_total
    FROM facturations_invoice_issuer_bindings b
    JOIN facturations_issued_invoice_documents d
      ON d.business_id=b.business_id
     AND d.issued_invoice_id=b.issued_invoice_id
     AND d.id=NEW.source_document_id
     AND d.content_sha256=NEW.source_document_sha256
    JOIN facturations_issuer_profiles p
      ON p.business_id=b.business_id
     AND p.id=b.issuer_profile_id
     AND p.profile_hash=b.issuer_profile_hash
     AND p.profile_version=b.issuer_profile_version
    JOIN facturations_issued_invoices i
      ON i.business_id=b.business_id
     AND i.id=b.issued_invoice_id
     AND i.status='ISSUED_CONFIRMED'
     AND i.delivery_state='NOT_AUTHORIZED'
   WHERE b.business_id=NEW.business_id
     AND b.id=NEW.binding_id
     AND b.issued_invoice_id=NEW.issued_invoice_id
     AND b.issuer_profile_id=NEW.issuer_profile_id
     AND b.issuer_profile_hash=NEW.issuer_profile_hash
     AND b.issuer_profile_version=NEW.issuer_profile_version
     AND d.delivery_state='NOT_AUTHORIZED'
     AND p.state='VERIFIED'
   FOR KEY SHARE OF b,d,p,i;

  IF NOT FOUND
     OR NEW.created_at<binding_bound_at
     OR NEW.created_at<source_created_at
     OR NEW.created_at<profile_verified_at
     OR NEW.created_at<invoice_materialized_at
     OR invoice_tax_total<0
     OR (invoice_tax_total>0 AND jsonb_array_length(profile_tax_registrations)<1) THEN
    RAISE EXCEPTION 'qualified invoice document integrity mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_qualified_document_integrity_guard
  ON facturations_qualified_invoice_documents;
CREATE TRIGGER facturations_qualified_document_integrity_guard
  BEFORE INSERT ON facturations_qualified_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_qualified_document_integrity();

ALTER TABLE facturations_qualified_invoice_documents
  ADD CONSTRAINT facturations_qualified_document_byte_integrity_check
  CHECK (
    render_version='invoice-pdf-v2-issuer-winansi'
    AND byte_length=octet_length(pdf_bytes)
    AND content_sha256=encode(sha256(pdf_bytes),'hex')
    AND substring(pdf_bytes FROM 1 FOR 5)=decode('255044462d','hex')
    AND position(
      decode('2525454f46','hex')
      IN substring(pdf_bytes FROM greatest(1,octet_length(pdf_bytes)-31))
    )>0
  );

COMMIT;
