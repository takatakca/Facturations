'use strict';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES=new Set([
  'NO_EVIDENCE','UNPAID','PARTIALLY_PAID','PAID','OVERPAID',
  'FULLY_REFUNDED','REFUND_EXCEEDS_PAYMENTS',
]);
const SCOPES=new Set(['NONE','SYNTHETIC_ONLY','VERIFIED_PROVIDER_PRESENT']);

class PaymentSummaryError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='PaymentSummaryError';
    this.code=code;
    this.statusCode=statusCode;
  }
}
function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new PaymentSummaryError(code);
  return value.toLowerCase();
}
function safeInt(value,code){
  const n=Number(value);
  if(!Number.isSafeInteger(n)) throw new PaymentSummaryError(code,503);
  return n;
}
function resultOf(row){
  if(!row || !STATES.has(row.financial_state) || !SCOPES.has(row.proof_scope)){
    throw new PaymentSummaryError('PAYMENT_SUMMARY_STORAGE_INVALID',503);
  }
  return Object.freeze({
    issuedInvoiceId:row.issued_invoice_id,
    invoiceTotalCents:safeInt(row.invoice_total_cents,'INVALID_INVOICE_TOTAL'),
    paidCents:safeInt(row.paid_cents,'INVALID_PAID_TOTAL'),
    refundedCents:safeInt(row.refunded_cents,'INVALID_REFUND_TOTAL'),
    netPaidCents:safeInt(row.net_paid_cents,'INVALID_NET_PAID_TOTAL'),
    balanceCents:safeInt(row.balance_cents,'INVALID_BALANCE_TOTAL'),
    evidenceCount:Number(row.evidence_count),
    hasPaymentEvidence:row.has_payment_evidence===true,
    hasRefundEvidence:row.has_refund_evidence===true,
    hasVerifiedProviderEvidence:row.has_verified_provider_evidence===true,
    financialState:row.financial_state,
    proofScope:row.proof_scope,
    firstEvidenceAt:row.first_evidence_at instanceof Date
      ? row.first_evidence_at.toISOString() : (row.first_evidence_at||null),
    lastEvidenceAt:row.last_evidence_at instanceof Date
      ? row.last_evidence_at.toISOString() : (row.last_evidence_at||null),
    externallyVerified:row.proof_scope==='VERIFIED_PROVIDER_PRESENT',
  });
}

function createPaymentSummaryStore({pool,businessId}={}){
  if(!pool || typeof pool.query!=='function') throw new TypeError('Dedicated PostgreSQL pool required');
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function getByIssuedInvoice(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='issuedInvoiceId'){
      throw new PaymentSummaryError('INVALID_PAYMENT_SUMMARY_LOOKUP');
    }
    const issuedInvoiceId=uuid(input.issuedInvoiceId,'INVALID_ISSUED_INVOICE_ID');
    const found=await pool.query(
      `SELECT * FROM facturations_payment_evidence_summary
        WHERE business_id=$1 AND issued_invoice_id=$2`,
      [tenant,issuedInvoiceId]
    );
    if(!found.rows.length) throw new PaymentSummaryError('PAYMENT_SUMMARY_NOT_FOUND',404);
    return resultOf(found.rows[0]);
  }

  return Object.freeze({getByIssuedInvoice});
}

module.exports={createPaymentSummaryStore,PaymentSummaryError};
