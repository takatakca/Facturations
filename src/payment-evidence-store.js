'use strict';

const crypto=require('node:crypto');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDER=/^[A-Z][A-Z0-9_]{1,63}$/;
const EVENT_TYPES=new Set(['PAYMENT_RECEIVED','REFUND_ISSUED']);

class PaymentEvidenceError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='PaymentEvidenceError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new PaymentEvidenceError(code);
  return value.toLowerCase();
}
function providerKey(value){
  if(typeof value!=='string' || !PROVIDER.test(value)){
    throw new PaymentEvidenceError('INVALID_PAYMENT_PROVIDER_KEY');
  }
  return value;
}
function boundedText(value,code,max=200){
  if(typeof value!=='string' || !value.trim() || value.trim().length>max ||
     /[\u0000-\u001f\u007f]/u.test(value)){
    throw new PaymentEvidenceError(code);
  }
  return value.trim();
}
function amount(value){
  if(!Number.isSafeInteger(value) || value<1){
    throw new PaymentEvidenceError('INVALID_PAYMENT_AMOUNT');
  }
  return value;
}
function occurredAt(value){
  if(typeof value!=='string') throw new PaymentEvidenceError('INVALID_PAYMENT_OCCURRED_AT');
  const ms=Date.parse(value);
  if(!Number.isFinite(ms)) throw new PaymentEvidenceError('INVALID_PAYMENT_OCCURRED_AT');
  return new Date(ms).toISOString();
}
function normalizeEvent(value){
  if(!value || typeof value!=='object' || Array.isArray(value) ||
     Object.keys(value).sort().join(',')!==
       'amountCents,currency,eventId,eventType,occurredAt,providerKey,providerTransactionId'){
    throw new PaymentEvidenceError('INVALID_PAYMENT_EVENT');
  }
  const type=value.eventType;
  if(typeof type!=='string' || !EVENT_TYPES.has(type)){
    throw new PaymentEvidenceError('INVALID_PAYMENT_EVENT_TYPE');
  }
  if(value.currency!=='CAD') throw new PaymentEvidenceError('INVALID_PAYMENT_CURRENCY');
  return Object.freeze({
    providerKey:providerKey(value.providerKey),
    eventId:boundedText(value.eventId,'INVALID_PAYMENT_EVENT_ID'),
    providerTransactionId:boundedText(
      value.providerTransactionId,'INVALID_PAYMENT_TRANSACTION_ID'
    ),
    eventType:type,
    amountCents:amount(value.amountCents),
    currency:'CAD',
    occurredAt:occurredAt(value.occurredAt),
  });
}
function canonical({issuedInvoiceId,event,sourceMode}){
  return {
    issuedInvoiceId,
    providerKey:event.providerKey,
    providerEventId:event.eventId,
    providerTransactionId:event.providerTransactionId,
    eventType:event.eventType,
    amountCents:event.amountCents,
    currency:event.currency,
    occurredAt:event.occurredAt,
    sourceMode,
  };
}
function evidenceHash(fields){
  return crypto.createHash('sha256')
    .update('facturations-payment-evidence-v1\0')
    .update(JSON.stringify(canonical(fields)))
    .digest('hex');
}
function resultOf(row){
  return Object.freeze({
    id:row.id,
    issuedInvoiceId:row.issued_invoice_id,
    providerKey:row.provider_key,
    providerEventId:row.provider_event_id,
    providerTransactionId:row.provider_transaction_id,
    eventType:row.event_type,
    amountCents:Number(row.amount_cents),
    currency:row.currency,
    occurredAt:row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    sourceMode:row.source_mode,
    evidenceHash:row.evidence_hash,
    recordedAt:row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
    externallyVerified:row.source_mode==='VERIFIED_PROVIDER_WEBHOOK',
  });
}

function createPaymentEvidenceStore({pool,businessId,providerKey:configuredProviderKey}={}){
  if(!pool || typeof pool.connect!=='function' || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();
  const provider=providerKey(configuredProviderKey);

  async function listByIssuedInvoice(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='issuedInvoiceId'){
      throw new PaymentEvidenceError('INVALID_PAYMENT_EVIDENCE_LOOKUP');
    }
    const issuedInvoiceId=uuid(input.issuedInvoiceId,'INVALID_ISSUED_INVOICE_ID');
    const found=await pool.query(
      `SELECT * FROM facturations_payment_evidence
        WHERE business_id=$1 AND issued_invoice_id=$2
        ORDER BY occurred_at,id`,
      [tenant,issuedInvoiceId]
    );
    return Object.freeze(found.rows.map(resultOf));
  }

  async function ingestSynthetic(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='event,issuedInvoiceId'){
      throw new PaymentEvidenceError('INVALID_SYNTHETIC_PAYMENT_REQUEST');
    }
    const issuedInvoiceId=uuid(input.issuedInvoiceId,'INVALID_ISSUED_INVOICE_ID');
    const event=normalizeEvent(input.event);
    if(event.providerKey!==provider){
      throw new PaymentEvidenceError('PAYMENT_PROVIDER_KEY_MISMATCH',409);
    }

    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;
      const invoice=await client.query(
        `SELECT id,status,provider,issued_snapshot
           FROM facturations_issued_invoices
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant,issuedInvoiceId]
      );
      if(!invoice.rows.length) throw new PaymentEvidenceError('ISSUED_INVOICE_NOT_FOUND',404);
      const row=invoice.rows[0];
      if(row.status!=='ISSUED_CONFIRMED' || row.provider!=='WAVE' ||
         row.issued_snapshot?.currency!=='CAD' ||
         !Number.isSafeInteger(row.issued_snapshot?.totalCents)){
        throw new PaymentEvidenceError('PAYMENT_EVIDENCE_SOURCE_NOT_READY',409);
      }

      const fields={issuedInvoiceId,event,sourceMode:'SYNTHETIC_TEST'};
      const hash=evidenceHash(fields);
      const inserted=await client.query(
        `INSERT INTO facturations_payment_evidence
           (business_id,issued_invoice_id,provider_key,provider_event_id,
            provider_transaction_id,event_type,amount_cents,currency,occurred_at,
            source_mode,evidence_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CAD',$8,'SYNTHETIC_TEST',$9)
         ON CONFLICT (business_id,provider_key,provider_event_id) DO NOTHING
         RETURNING *`,
        [tenant,issuedInvoiceId,event.providerKey,event.eventId,event.providerTransactionId,
         event.eventType,event.amountCents,event.occurredAt,hash]
      );
      let saved=inserted.rows[0];
      if(!saved){
        const prior=await client.query(
          `SELECT * FROM facturations_payment_evidence
            WHERE business_id=$1 AND provider_key=$2 AND provider_event_id=$3`,
          [tenant,event.providerKey,event.eventId]
        );
        saved=prior.rows[0];
        if(!saved ||
           saved.issued_invoice_id!==issuedInvoiceId ||
           saved.provider_transaction_id!==event.providerTransactionId ||
           saved.event_type!==event.eventType ||
           Number(saved.amount_cents)!==event.amountCents ||
           saved.currency!=='CAD' ||
           new Date(saved.occurred_at).toISOString()!==event.occurredAt ||
           saved.source_mode!=='SYNTHETIC_TEST' ||
           saved.evidence_hash!==hash){
          throw new PaymentEvidenceError('PAYMENT_EVIDENCE_EVENT_CONFLICT',409);
        }
      }

      await client.query('COMMIT');
      transaction=false;
      return resultOf(saved);
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  return Object.freeze({
    providerKey:provider,
    ingestSynthetic,
    listByIssuedInvoice,
  });
}

module.exports={createPaymentEvidenceStore,PaymentEvidenceError,normalizePaymentEvidenceEvent:normalizeEvent};
