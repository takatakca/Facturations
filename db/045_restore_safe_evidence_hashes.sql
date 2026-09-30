-- Apply ONLY to the dedicated Facturations database, after migrations 001-044.
-- Forward fix: make evidence-hash functions self-contained so pg_dump/pg_restore
-- does not depend on helper-function restore ordering.
-- No external provider, email, payment or refund action is performed.
BEGIN;

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
  confirmed_at_iso text;
BEGIN
  confirmed_at_iso := to_char(
    date_trunc('milliseconds',p_provider_confirmed_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

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
    ',"providerConfirmedAt":'||to_json(confirmed_at_iso)::text||'}';

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
  occurred_at_iso text;
BEGIN
  occurred_at_iso := to_char(
    date_trunc('milliseconds',p_occurred_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  canonical :=
    '{"qualifiedDocumentId":'||to_json(p_qualified_document_id::text)::text||
    ',"qualifiedDocumentSha256":'||to_json(p_qualified_document_sha256)::text||
    ',"operationKey":'||to_json(p_operation_key)::text||
    ',"providerKey":'||to_json(p_provider_key)::text||
    ',"providerMessageId":'||to_json(p_provider_message_id)::text||
    ',"providerEventId":'||to_json(p_provider_event_id)::text||
    ',"eventType":'||to_json(p_event_type)::text||
    ',"occurredAt":'||to_json(occurred_at_iso)::text||
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
  occurred_at_iso text;
BEGIN
  occurred_at_iso := to_char(
    date_trunc('milliseconds',p_occurred_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

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
    ',"occurredAt":'||to_json(occurred_at_iso)::text||
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

COMMIT;
