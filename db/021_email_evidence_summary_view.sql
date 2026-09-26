-- Apply ONLY to the dedicated Facturations database, after migrations 001-020.
-- Adds a read-only projection over the append-only evidence ledger.
BEGIN;

CREATE OR REPLACE VIEW facturations_email_provider_evidence_summary AS
SELECT
  business_id,
  qualified_document_id,
  provider_key,
  provider_message_id,
  count(*)::integer AS event_count,
  min(occurred_at) AS first_event_at,
  max(occurred_at) AS latest_event_at,
  (array_agg(event_type ORDER BY occurred_at DESC, id DESC))[1] AS latest_event_type,
  bool_or(event_type = 'DELIVERED') AS has_delivered,
  bool_or(event_type = 'BOUNCED') AS has_bounced,
  bool_or(event_type = 'COMPLAINT') AS has_complaint,
  max(occurred_at) FILTER (WHERE event_type = 'DELIVERED') AS last_delivered_at,
  max(occurred_at) FILTER (WHERE event_type = 'BOUNCED') AS last_bounced_at,
  max(occurred_at) FILTER (WHERE event_type = 'COMPLAINT') AS last_complaint_at,
  bool_and(source_mode = 'SYNTHETIC_TEST') AS synthetic_only,
  bool_or(source_mode = 'SIGNED_WEBHOOK') AS has_signed_webhook
FROM facturations_email_provider_evidence
GROUP BY business_id, qualified_document_id, provider_key, provider_message_id;

COMMIT;
