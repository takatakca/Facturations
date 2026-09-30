-- Apply ONLY to the dedicated Facturations database, after migrations 001-030.
-- Requires every refund evidence row to reference an existing payment evidence row.
-- Existing orphan refund rows make this migration fail closed for manual review.
BEGIN;

ALTER TABLE facturations_payment_evidence
  ADD COLUMN related_payment_evidence_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM facturations_payment_evidence
     WHERE event_type='REFUND_ISSUED'
       AND related_payment_evidence_id IS NULL
  ) THEN
    RAISE EXCEPTION 'orphan refund evidence requires manual review';
  END IF;
END;
$$;

ALTER TABLE facturations_payment_evidence
  ADD CONSTRAINT facturations_payment_evidence_refund_relation_check
  CHECK (
    (event_type='PAYMENT_RECEIVED' AND related_payment_evidence_id IS NULL)
    OR
    (event_type='REFUND_ISSUED' AND related_payment_evidence_id IS NOT NULL)
  );

ALTER TABLE facturations_payment_evidence
  ADD CONSTRAINT facturations_payment_evidence_related_payment_fk
  FOREIGN KEY (business_id,related_payment_evidence_id)
  REFERENCES facturations_payment_evidence(business_id,id)
  ON DELETE RESTRICT;

CREATE INDEX facturations_payment_evidence_related_payment_idx
  ON facturations_payment_evidence
     (business_id,related_payment_evidence_id,occurred_at,id)
  WHERE related_payment_evidence_id IS NOT NULL;

COMMIT;
