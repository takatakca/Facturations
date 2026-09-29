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
  address_json text;
  tax_json text;
  canonical text;
BEGIN
  IF jsonb_typeof(p_address_lines)<>'array' OR
     jsonb_array_length(p_address_lines) NOT BETWEEN 1 AND 3 OR
     EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_address_lines) e
        WHERE jsonb_typeof(e)<>'string'
     ) THEN
    RAISE EXCEPTION 'invalid issuer profile address structure'
      USING ERRCODE='23514';
  END IF;

  IF jsonb_typeof(p_tax_registrations)<>'array' OR
     jsonb_array_length(p_tax_registrations)>10 OR
     EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_tax_registrations) e
        WHERE jsonb_typeof(e)<>'object'
           OR NOT (e ? 'scheme')
           OR NOT (e ? 'registrationNumber')
           OR jsonb_object_length(e)<>2
           OR jsonb_typeof(e->'scheme')<>'string'
           OR jsonb_typeof(e->'registrationNumber')<>'string'
           OR length(e->>'scheme') NOT BETWEEN 1 AND 40
           OR length(e->>'registrationNumber') NOT BETWEEN 1 AND 80
           OR (e->>'scheme')<>upper(e->>'scheme')
     ) THEN
    RAISE EXCEPTION 'invalid issuer profile tax structure'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(
    string_agg(to_json(value)::text,',' ORDER BY ord),
    ''
  )
    INTO address_json
    FROM jsonb_array_elements_text(p_address_lines)
      WITH ORDINALITY AS a(value,ord);

  SELECT COALESCE(
    string_agg(
      '{"scheme":'||to_json(e->>'scheme')::text||
      ',"registrationNumber":'||to_json(e->>'registrationNumber')::text||'}',
      ',' ORDER BY ord
    ),
    ''
  )
    INTO tax_json
    FROM jsonb_array_elements(p_tax_registrations)
      WITH ORDINALITY AS t(e,ord);

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
  expected_hash text;
  expected_version integer;
  owner_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id,0));

  expected_hash := facturations_compute_issuer_profile_hash(
    NEW.legal_name,
    NEW.display_name,
    NEW.address_lines,
    NEW.city,
    NEW.region,
    NEW.postal_code,
    NEW.country_code,
    NEW.contact_email,
    NEW.contact_phone,
    NEW.tax_registrations
  );

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

  IF NEW.profile_hash<>expected_hash OR
     NEW.profile_version<>expected_version OR
     NOT owner_ok OR
     NEW.state<>'VERIFIED' OR
     NEW.verification_method<>'HUMAN_DOCUMENT_REVIEW' OR
     NEW.created_at<NEW.verified_at THEN
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

CREATE OR REPLACE FUNCTION facturations_validate_qualified_document_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding_invoice_id uuid;
  binding_profile_id uuid;
  binding_profile_hash text;
  binding_profile_version integer;
  binding_bound_at timestamptz;
  source_invoice_id uuid;
  source_sha256 text;
  source_bytes bytea;
  source_created_at timestamptz;
  source_delivery_state text;
  profile_hash text;
  profile_version integer;
  profile_verified_at timestamptz;
  profile_state text;
  profile_tax_registrations jsonb;
  actual_profile_hash text;
  invoice_status text;
  invoice_delivery_state text;
  invoice_materialized_at timestamptz;
  invoice_tax_total bigint;
  actual_sha256 text;
  pdf_tail bytea;
BEGIN
  SELECT
      b.issued_invoice_id,
      b.issuer_profile_id,
      b.issuer_profile_hash,
      b.issuer_profile_version,
      b.bound_at,
      d.issued_invoice_id,
      d.content_sha256,
      d.pdf_bytes,
      d.created_at,
      d.delivery_state,
      p.profile_hash,
      p.profile_version,
      p.verified_at,
      p.state,
      p.tax_registrations,
      facturations_compute_issuer_profile_hash(
        p.legal_name,p.display_name,p.address_lines,p.city,p.region,
        p.postal_code,p.country_code,p.contact_email,p.contact_phone,
        p.tax_registrations
      ),
      i.status,
      i.delivery_state,
      i.materialized_at,
      CASE
        WHEN jsonb_typeof(i.issued_snapshot->'taxTotalCents')='number'
          THEN (i.issued_snapshot->>'taxTotalCents')::bigint
        ELSE -1
      END
    INTO
      binding_invoice_id,
      binding_profile_id,
      binding_profile_hash,
      binding_profile_version,
      binding_bound_at,
      source_invoice_id,
      source_sha256,
      source_bytes,
      source_created_at,
      source_delivery_state,
      profile_hash,
      profile_version,
      profile_verified_at,
      profile_state,
      profile_tax_registrations,
      actual_profile_hash,
      invoice_status,
      invoice_delivery_state,
      invoice_materialized_at,
      invoice_tax_total
    FROM facturations_invoice_issuer_bindings b
    JOIN facturations_issued_invoice_documents d
      ON d.business_id=b.business_id
     AND d.id=NEW.source_document_id
    JOIN facturations_issuer_profiles p
      ON p.business_id=b.business_id
     AND p.id=b.issuer_profile_id
    JOIN facturations_issued_invoices i
      ON i.business_id=b.business_id
     AND i.id=b.issued_invoice_id
   WHERE b.business_id=NEW.business_id
     AND b.id=NEW.binding_id
   FOR KEY SHARE OF b,d,p,i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'qualified invoice document provenance source not found'
      USING ERRCODE='23514';
  END IF;

  actual_sha256 := encode(sha256(NEW.pdf_bytes),'hex');
  pdf_tail := substring(
    NEW.pdf_bytes FROM greatest(1,octet_length(NEW.pdf_bytes)-31)
  );

  IF binding_invoice_id<>NEW.issued_invoice_id OR
     source_invoice_id<>NEW.issued_invoice_id OR
     binding_profile_id<>NEW.issuer_profile_id OR
     binding_profile_hash<>NEW.issuer_profile_hash OR
     binding_profile_version<>NEW.issuer_profile_version OR
     profile_hash<>NEW.issuer_profile_hash OR
     profile_version<>NEW.issuer_profile_version OR
     profile_hash<>actual_profile_hash OR
     source_sha256<>NEW.source_document_sha256 OR
     source_sha256<>encode(sha256(source_bytes),'hex') OR
     source_delivery_state<>'NOT_AUTHORIZED' OR
     profile_state<>'VERIFIED' OR
     invoice_status<>'ISSUED_CONFIRMED' OR
     invoice_delivery_state<>'NOT_AUTHORIZED' OR
     NEW.document_kind<>'QUALIFIED_INVOICE_PDF' OR
     NEW.render_version<>'invoice-pdf-v2-issuer-winansi' OR
     NEW.content_type<>'application/pdf' OR
     NEW.byte_length<>octet_length(NEW.pdf_bytes) OR
     NEW.content_sha256<>actual_sha256 OR
     substring(NEW.pdf_bytes FROM 1 FOR 5)<>decode('255044462d','hex') OR
     position(decode('2525454f46','hex') IN pdf_tail)=0 OR
     NEW.delivery_state<>'NOT_AUTHORIZED' OR
     NEW.created_at<binding_bound_at OR
     NEW.created_at<source_created_at OR
     NEW.created_at<profile_verified_at OR
     NEW.created_at<invoice_materialized_at OR
     invoice_tax_total<0 OR
     (invoice_tax_total>0 AND jsonb_array_length(profile_tax_registrations)<1) THEN
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

COMMIT;
