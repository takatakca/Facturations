-- Apply ONLY to the dedicated Facturations database, after migrations 001-023.
-- Read-only financial projection over the append-only payment evidence ledger.
BEGIN;

CREATE OR REPLACE VIEW facturations_payment_evidence_summary AS
SELECT
  i.business_id,
  i.id AS issued_invoice_id,
  (i.issued_snapshot->>'totalCents')::bigint AS invoice_total_cents,
  COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)::bigint AS paid_cents,
  COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)::bigint AS refunded_cents,
  (
    COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
    -
    COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
  )::bigint AS net_paid_cents,
  (
    (i.issued_snapshot->>'totalCents')::bigint
    -
    (
      COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      -
      COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
    )
  )::bigint AS balance_cents,
  COUNT(e.id)::integer AS evidence_count,
  COALESCE(BOOL_OR(e.event_type='PAYMENT_RECEIVED'),false) AS has_payment_evidence,
  COALESCE(BOOL_OR(e.event_type='REFUND_ISSUED'),false) AS has_refund_evidence,
  COALESCE(BOOL_OR(e.source_mode='VERIFIED_PROVIDER_WEBHOOK'),false) AS has_verified_provider_evidence,
  CASE
    WHEN COUNT(e.id)=0 THEN 'NO_EVIDENCE'
    WHEN COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
       > COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      THEN 'REFUND_EXCEEDS_PAYMENTS'
    WHEN COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)>0
      AND COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
        = COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      THEN 'FULLY_REFUNDED'
    WHEN (
      COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      -
      COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
    ) > (i.issued_snapshot->>'totalCents')::bigint
      THEN 'OVERPAID'
    WHEN (
      COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      -
      COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
    ) = (i.issued_snapshot->>'totalCents')::bigint
      THEN 'PAID'
    WHEN (
      COALESCE(SUM(CASE WHEN e.event_type='PAYMENT_RECEIVED' THEN e.amount_cents ELSE 0 END),0)
      -
      COALESCE(SUM(CASE WHEN e.event_type='REFUND_ISSUED' THEN e.amount_cents ELSE 0 END),0)
    ) > 0
      THEN 'PARTIALLY_PAID'
    ELSE 'UNPAID'
  END AS financial_state,
  CASE
    WHEN COUNT(e.id)=0 THEN 'NONE'
    WHEN COALESCE(BOOL_OR(e.source_mode='VERIFIED_PROVIDER_WEBHOOK'),false)
      THEN 'VERIFIED_PROVIDER_PRESENT'
    ELSE 'SYNTHETIC_ONLY'
  END AS proof_scope,
  MIN(e.occurred_at) AS first_evidence_at,
  MAX(e.occurred_at) AS last_evidence_at
FROM facturations_issued_invoices AS i
LEFT JOIN facturations_payment_evidence AS e
  ON e.business_id=i.business_id AND e.issued_invoice_id=i.id
WHERE i.status='ISSUED_CONFIRMED'
GROUP BY i.business_id,i.id,i.issued_snapshot;

COMMIT;
