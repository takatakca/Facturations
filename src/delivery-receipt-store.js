'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class DeliveryReceiptError extends Error {
  constructor(code,statusCode=422){
    super(code);
    this.name='DeliveryReceiptError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new DeliveryReceiptError(code);
  return value.toLowerCase();
}

function canonicalReceipt(row){
  return {
    attemptId:row.attempt_id,
    authorizationId:row.authorization_id,
    issuedInvoiceId:row.issued_invoice_id,
    qualifiedDocumentId:row.qualified_document_id,
    qualifiedDocumentSha256:row.qualified_document_sha256,
    expectedRecipientEmail:row.expected_recipient_email,
    recipientSnapshotHash:row.recipient_snapshot_hash,
    provider:row.provider,
    providerMessageId:row.provider_message_id,
    operationKey:row.operation_key,
    providerConfirmedAt:row.finished_at instanceof Date
      ? row.finished_at.toISOString() : row.finished_at,
  };
}

function receiptHash(row){
  return crypto.createHash('sha256')
    .update('facturations-delivery-receipt-v1\0')
    .update(JSON.stringify(canonicalReceipt(row)))
    .digest('hex');
}

function resultOf(row){
  return Object.freeze({
    id:row.id,
    attemptId:row.attempt_id,
    authorizationId:row.authorization_id,
    issuedInvoiceId:row.issued_invoice_id,
    qualifiedDocumentId:row.qualified_document_id,
    qualifiedDocumentSha256:row.qualified_document_sha256,
    expectedRecipientEmail:row.expected_recipient_email,
    recipientSnapshotHash:row.recipient_snapshot_hash,
    provider:row.provider,
    providerMessageId:row.provider_message_id,
    operationKey:row.operation_key,
    receiptHash:row.receipt_hash,
    status:row.status,
    proofScope:row.proof_scope,
    providerConfirmedAt:row.provider_confirmed_at instanceof Date
      ? row.provider_confirmed_at.toISOString() : row.provider_confirmed_at,
    materializedAt:row.materialized_at instanceof Date
      ? row.materialized_at.toISOString() : row.materialized_at,
    simulated:true,
    realEmailProven:false,
  });
}

function createDeliveryReceiptStore({pool,businessId}){
  if(!pool || typeof pool.connect!=='function' || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function getByAttempt(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='attemptId'){
      throw new DeliveryReceiptError('INVALID_DELIVERY_RECEIPT_LOOKUP');
    }
    const attemptId=uuid(input.attemptId,'INVALID_ATTEMPT_ID');
    const found=await pool.query(
      'SELECT * FROM facturations_delivery_receipts WHERE business_id=$1 AND attempt_id=$2',
      [tenant,attemptId]
    );
    if(!found.rows.length) throw new DeliveryReceiptError('DELIVERY_RECEIPT_NOT_FOUND',404);
    return resultOf(found.rows[0]);
  }

  async function materialize(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='attemptId'){
      throw new DeliveryReceiptError('INVALID_DELIVERY_RECEIPT_REQUEST');
    }
    const attemptId=uuid(input.attemptId,'INVALID_ATTEMPT_ID');
    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;

      const chain=await client.query(
        `SELECT
            t.id AS attempt_id,t.authorization_id,t.issued_invoice_id,t.qualified_document_id,
            t.provider,t.operation_key,t.state AS attempt_state,t.provider_message_id,t.finished_at,
            a.qualified_document_sha256,a.expected_recipient_email,a.recipient_snapshot_hash,
            a.state AS authorization_state,
            q.content_sha256 AS actual_document_sha256,q.delivery_state AS document_delivery_state,
            i.status AS invoice_status,i.delivery_state AS invoice_delivery_state,i.issued_snapshot
           FROM facturations_delivery_attempts AS t
           JOIN facturations_delivery_authorizations AS a
             ON a.business_id=t.business_id AND a.id=t.authorization_id
           JOIN facturations_qualified_invoice_documents AS q
             ON q.business_id=t.business_id AND q.id=t.qualified_document_id
           JOIN facturations_issued_invoices AS i
             ON i.business_id=t.business_id AND i.id=t.issued_invoice_id
          WHERE t.business_id=$1 AND t.id=$2
          FOR SHARE OF t,a,q,i`,
        [tenant,attemptId]
      );
      if(!chain.rows.length) throw new DeliveryReceiptError('DELIVERY_ATTEMPT_NOT_FOUND',404);
      const row=chain.rows[0];

      if(row.attempt_state!=='CONFIRMED' || row.provider!=='SIMULATED_EMAIL' ||
         !row.provider_message_id || !row.finished_at){
        throw new DeliveryReceiptError('CONFIRMED_DELIVERY_ATTEMPT_REQUIRED',409);
      }
      if(row.authorization_state!=='AUTHORIZED_PENDING_DELIVERY' ||
         row.invoice_status!=='ISSUED_CONFIRMED' ||
         row.document_delivery_state!=='NOT_AUTHORIZED' ||
         row.invoice_delivery_state!=='NOT_AUTHORIZED'){
        throw new DeliveryReceiptError('DELIVERY_RECEIPT_CHAIN_NOT_READY',409);
      }
      const snapshotEmail=row.issued_snapshot?.customer?.email;
      if(row.qualified_document_sha256!==row.actual_document_sha256 ||
         typeof snapshotEmail!=='string' ||
         snapshotEmail.trim().toLowerCase()!==row.expected_recipient_email){
        throw new DeliveryReceiptError('DELIVERY_RECEIPT_PROVENANCE_MISMATCH',409);
      }

      const hash=receiptHash(row);
      const inserted=await client.query(
        `INSERT INTO facturations_delivery_receipts
           (business_id,attempt_id,authorization_id,issued_invoice_id,qualified_document_id,
            qualified_document_sha256,expected_recipient_email,recipient_snapshot_hash,
            provider,provider_message_id,operation_key,receipt_hash,provider_confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          tenant,row.attempt_id,row.authorization_id,row.issued_invoice_id,row.qualified_document_id,
          row.qualified_document_sha256,row.expected_recipient_email,row.recipient_snapshot_hash,
          row.provider,row.provider_message_id,row.operation_key,hash,row.finished_at,
        ]
      );
      let saved=inserted.rows[0];
      if(!saved){
        const prior=await client.query(
          `SELECT * FROM facturations_delivery_receipts
            WHERE business_id=$1 AND attempt_id=$2`,
          [tenant,row.attempt_id]
        );
        saved=prior.rows[0];
        if(!saved ||
           saved.authorization_id!==row.authorization_id ||
           saved.issued_invoice_id!==row.issued_invoice_id ||
           saved.qualified_document_id!==row.qualified_document_id ||
           saved.qualified_document_sha256!==row.qualified_document_sha256 ||
           saved.expected_recipient_email!==row.expected_recipient_email ||
           saved.recipient_snapshot_hash!==row.recipient_snapshot_hash ||
           saved.provider!==row.provider ||
           saved.provider_message_id!==row.provider_message_id ||
           saved.operation_key!==row.operation_key ||
           saved.receipt_hash!==hash ||
           saved.status!=='DELIVERY_CONFIRMED_SIMULATED' ||
           saved.proof_scope!=='SIMULATED_ADAPTER_ONLY'){
          throw new DeliveryReceiptError('DELIVERY_RECEIPT_CONFLICT',409);
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

  return Object.freeze({materialize,getByAttempt});
}

module.exports={createDeliveryReceiptStore,DeliveryReceiptError};
