-- Apply ONLY to the dedicated Facturations database, after migrations 001-043.
-- Finalizes deterministic local evidence hashes in PostgreSQL.
-- External signatures/HMAC verification remain separate trust proofs.
BEGIN;

CREATE OR REPLACE FUNCTION facturations_iso_millis(p_value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT to_char(
    date_trunc('milliseconds',p_value) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$$;

CREATE OR REPLACE FUNCTION facturations_compute_delivery_recipient_hash(
  p_email text,
  p_customer_name text,
  p_qualified_document_id uuid,
  p_qualified_document_sha256 text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  canonical text;
BEGIN
  canonical :=
    '{"email":'||to_json(p_email)::text||
    ',"customerName":'||
      CASE WHEN p_customer_name IS NULL THEN 'null'
           ELSE to_json(p_customer_name)::text END||
    ',"qualifiedDocumentId":'||to_json(p_qualified_document_id::text)::text||
    ',"qualifiedDocumentSha256":'||to_json(p_qualified_document_sha256)::text||'}';

  RETURN encode(
    sha256(
      convert_to('facturations-delivery-recipient-v1','UTF8')||
      decode('00','hex')||
      convert_to(canonical,'UTF8')
    ),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION facturations_validate_delivery_authorization_hash()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_invoice_id uuid;
  document_sha256 text;
  snapshot_email text;
  snapshot_name text;
  owner_ok boolean;
  expected_hash text;
BEGIN
  SELECT q.issued_invoice_id,q.content_sha256
    INTO document_invoice_id,document_sha256
    FROM facturations_qualified_invoice_documents q
   WHERE q.business_id=NEW.business_id
     AND q.id=NEW.qualified_document_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF document_invoice_id<>NEW.issued_invoice_id
     OR document_sha256<>NEW.qualified_document_sha256 THEN
    RETURN NEW;
  END IF;

  SELECT
      i.issued_snapshot#>>'{customer,email}',
      i.issued_snapshot#>>'{customer,name}'
    INTO snapshot_email,snapshot_name
    FROM facturations_issued_invoices i
   WHERE i.business_id=NEW.business_id
     AND i.id=NEW.issued_invoice_id
     AND i.status='ISSUED_CONFIRMED'
     AND i.delivery_state='NOT_AUTHORIZED'
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery authorization hash source not ready'
      USING ERRCODE='23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM facturations_staff_users u
     WHERE u.business_id=NEW.business_id
       AND u.id=NEW.authorized_by
       AND u.role='OWNER'
       AND u.enabled
       AND u.email_verified_at IS NOT NULL
  ) INTO owner_ok;

  expected_hash := facturations_compute_delivery_recipient_hash(
    NEW.expected_recipient_email,
    snapshot_name,
    NEW.qualified_document_id,
    NEW.qualified_document_sha256
  );

  IF snapshot_email IS NULL
     OR lower(snapshot_email)<>NEW.expected_recipient_email
     OR NEW.recipient_snapshot_hash<>expected_hash
     OR NOT owner_ok THEN
    RAISE EXCEPTION 'delivery authorization recipient hash mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_delivery_authorization_hash_guard
  ON facturations_delivery_authorizations;
CREATE TRIGGER facturations_delivery_authorization_hash_guard
  BEFORE INSERT ON facturations_delivery_authorizations
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_delivery_authorization_hash();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM facturations_delivery_authorizations a
      JOIN facturations_issued_invoices i
        ON i.business_id=a.business_id AND i.id=a.issued_invoice_id
     WHERE a.recipient_snapshot_hash <>
       facturations_compute_delivery_recipient_hash(
         a.expected_recipient_email,
         i.issued_snapshot#>>'{customer,name}',
         a.qualified_document_id,
         a.qualified_document_sha256
       )
  ) THEN
    RAISE EXCEPTION 'existing delivery authorization recipient hash mismatch';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION facturations_compute_delivery_receipt_hash(
  p_attempt_id uuid,
  p_authorization_id uuid,
  p_issued_invoice_id uuid,
  p_qualified_document_id uuid,
  p_qualified_document_sha256 text,
  p_expected_recipient_email text,
  p_recipient_snapshot_hash text,
  p_provider text,
  p_provider_message_id text,
  p_operation_key text,
  p_provider_confirmed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  canonical text;
BEGIN
  canonical :=
    '{"attemptId":'||to_json(p_attempt_id::text)::text||
    ',"authorizationId":'||to_json(p_authorization_id::text)::text||
    ',"issuedInvoiceId":'||to_json(p_issued_invoice_id::text)::text||
    ',"qualifiedDocumentId":'||to_json(p_qualified_document_id::text)::text||
    ',"qualifiedDocumentSha256":'||to_json(p_qualified_document_sha256)::text||
    ',"expectedRecipientEmail":'||to_json(p_expected_recipient_email)::text||
    ',"recipientSnapshotHash":'||to_json(p_recipient_snapshot_hash)::text||
    ',"provider":'||to_json(p_provider)::text||
    ',"providerMessageId":'||to_json(p_provider_message_id)::text||
    ',"operationKey":'||to_json(p_operation_key)::text||
    ',"providerConfirmedAt":'||to_json(facturations_iso_millis(p_provider_confirmed_at))::text||'}';

  RETURN encode(
    sha256(
      convert_to('facturations-delivery-receipt-v1','UTF8')||
      decode('00','hex')||
      convert_to(canonical,'UTF8')
    ),
    'hex'
  );
END;
$$;

ALTER TABLE facturations_delivery_receipts
  ADD CONSTRAINT facturations_delivery_receipt_hash_integrity_check
  CHECK (
    receipt_hash = facturations_compute_delivery_receipt_hash(
      attempt_id,authorization_id,issued_invoice_id,qualified_document_id,
      qualified_document_sha256,expected_recipient_email,recipient_snapshot_hash,
      provider,provider_message_id,operation_key,provider_confirmed_at
    )
  );

CREATE OR REPLACE FUNCTION facturations_compute_email_evidence_hash(
  p_qualified_document_id uuid,
  p_qualified_document_sha256 text,
  p_operation_key text,
  p_provider_key text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_recipient_email text,
  p_source_mode text,
  p_webhook_body_sha256 text,
  p_verification_scheme text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  canonical text;
BEGIN
  canonical :=
    '{"qualifiedDocumentId":'||to_json(p_qualified_document_id::text)::text||
    ',"qualifiedDocumentSha256":'||to_json(p_qualified_document_sha256)::text||
    ',"operationKey":'||to_json(p_operation_key)::text||
    ',"providerKey":'||to_json(p_provider_key)::text||
    ',"providerMessageId":'||to_json(p_provider_message_id)::text||
    ',"providerEventId":'||to_json(p_provider_event_id)::text||
    ',"eventType":'||to_json(p_event_type)::text||
    ',"occurredAt":'||to_json(facturations_iso_millis(p_occurred_at))::text||
    ',"recipientEmail":'||to_json(p_recipient_email)::text||
    ',"sourceMode":'||to_json(p_source_mode)::text;

  IF p_source_mode='SIGNED_WEBHOOK' THEN
    canonical := canonical||
      ',"webhookBodySha256":'||to_json(p_webhook_body_sha256)::text||
      ',"verificationScheme":'||to_json(p_verification_scheme)::text;
  END IF;

  canonical := canonical||'}';

  RETURN encode(
    sha256(
      convert_to('facturations-email-provider-evidence-v1','UTF8')||
      decode('00','hex')||
      convert_to(canonical,'UTF8')
    ),
    'hex'
  );
END;
$$;

ALTER TABLE facturations_email_provider_evidence
  ADD CONSTRAINT facturations_email_evidence_hash_integrity_check
  CHECK (
    evidence_hash = facturations_compute_email_evidence_hash(
      qualified_document_id,qualified_document_sha256,operation_key,provider_key,
      provider_message_id,provider_event_id,event_type,occurred_at,recipient_email,
      source_mode,webhook_body_sha256,verification_scheme
    )
  );

CREATE OR REPLACE FUNCTION facturations_compute_payment_evidence_hash(
  p_issued_invoice_id uuid,
  p_provider_key text,
  p_provider_event_id text,
  p_provider_transaction_id text,
  p_related_provider_transaction_id text,
  p_event_type text,
  p_amount_cents bigint,
  p_currency text,
  p_occurred_at timestamptz,
  p_source_mode text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  canonical text;
BEGIN
  canonical :=
    '{"issuedInvoiceId":'||to_json(p_issued_invoice_id::text)::text||
    ',"providerKey":'||to_json(p_provider_key)::text||
    ',"providerEventId":'||to_json(p_provider_event_id)::text||
    ',"providerTransactionId":'||to_json(p_provider_transaction_id)::text||
    ',"relatedProviderTransactionId":'||
      CASE WHEN p_related_provider_transaction_id IS NULL THEN 'null'
           ELSE to_json(p_related_provider_transaction_id)::text END||
    ',"eventType":'||to_json(p_event_type)::text||
    ',"amountCents":'||p_amount_cents::text||
    ',"currency":'||to_json(p_currency)::text||
    ',"occurredAt":'||to_json(facturations_iso_millis(p_occurred_at))::text||
    ',"sourceMode":'||to_json(p_source_mode)::text||'}';

  RETURN encode(
    sha256(
      convert_to('facturations-payment-evidence-v1','UTF8')||
      decode('00','hex')||
      convert_to(canonical,'UTF8')
    ),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION facturations_validate_payment_evidence_hash()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  related_transaction_id text;
  expected_hash text;
BEGIN
  related_transaction_id := NULL;

  IF NEW.event_type='REFUND_ISSUED' THEN
    SELECT provider_transaction_id
      INTO related_transaction_id
      FROM facturations_payment_evidence
     WHERE business_id=NEW.business_id
       AND id=NEW.related_payment_evidence_id
     FOR KEY SHARE;

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  expected_hash := facturations_compute_payment_evidence_hash(
    NEW.issued_invoice_id,
    NEW.provider_key,
    NEW.provider_event_id,
    NEW.provider_transaction_id,
    related_transaction_id,
    NEW.event_type,
    NEW.amount_cents,
    NEW.currency,
    NEW.occurred_at,
    NEW.source_mode
  );

  IF NEW.evidence_hash<>expected_hash THEN
    RAISE EXCEPTION 'payment evidence hash mismatch'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS facturations_payment_evidence_z_hash_guard
  ON facturations_payment_evidence;
CREATE TRIGGER facturations_payment_evidence_z_hash_guard
  BEFORE INSERT ON facturations_payment_evidence
  FOR EACH ROW EXECUTE FUNCTION facturations_validate_payment_evidence_hash();

DO $$
DECLARE
  bad_count bigint;
BEGIN
  SELECT count(*)
    INTO bad_count
    FROM facturations_payment_evidence e
    LEFT JOIN facturations_payment_evidence parent
      ON parent.business_id=e.business_id
     AND parent.id=e.related_payment_evidence_id
   WHERE e.evidence_hash <>
     facturations_compute_payment_evidence_hash(
       e.issued_invoice_id,
       e.provider_key,
       e.provider_event_id,
       e.provider_transaction_id,
       CASE WHEN e.event_type='REFUND_ISSUED'
            THEN parent.provider_transaction_id ELSE NULL END,
       e.event_type,
       e.amount_cents,
       e.currency,
       e.occurred_at,
       e.source_mode
     );

  IF bad_count<>0 THEN
    RAISE EXCEPTION 'existing payment evidence hash mismatch';
  END IF;
END;
$$;

COMMIT;
