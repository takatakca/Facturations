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

function receiptHash(row){
  return crypto.createHash('sha256')
    .update('facturations-delivery-receipt-v1\0')
    .update(JSON.stringify({
      attemptId:row.attempt_id,
      authorizationId:row.authorization_id,
      issuedInvoiceId:row.issued_invoice_id,
      qualifiedDocumentId:row.qualified_document_id,
      qualifiedDocumentSha256:row.qualified_document_sha256,
      expectedRecipientEmail:row.expected_recipient_email,
      recipientSnapshotHash:row.recipient_snapshot_hash,
      provider:row.provider,
      providerMessageId:row.provider_message_id,
      providerConfirmedAt:new Date(row.provider_confirmed_at).toISOString(),
    }))
    .digest('hex');
}

function asResult(row){
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
    providerConfirmedAt:row.provider_confirmed_at instanceof Date
      ? row.provider_confirmed_at.toISOString() : row.provider_confirmed_at,
    receiptSha256:row.receipt_sha256,
    materializedAt:row.materialized_at instanceof Date
      ? row.materialized_at.toISOString() : row.materialized_at,
    externalDeliveryIndependentlyVerified:false,
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

  async function materialize(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='attemptId'){
      throw new DeliveryReceiptError('INVALID_RECEIPT_REQUEST');
    }
    const attemptId=uuid(input.attemptId,'INVALID_ATTEMPT_ID');
    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;
      const found=await client.query(
        `SELECT d.id AS attempt_id,d.authorization_id,d.issued_invoice_id,
                d.qualified_document_id,d.provider,d.provider_message_id,
                d.finished_at AS provider_confirmed_at,d.state,
                a.qualified_document_sha256,a.expected_recipient_email,
                a.recipient_snapshot_hash,a.state AS authorization_state,
                q.content_sha256,q.delivery_state AS document_delivery_state,
                i.status AS invoice_status,i.delivery_state AS invoice_delivery_state,
                i.issued_snapshot
           FROM facturations_delivery_attempts AS d
           JOIN facturations_delivery_authorizations AS a
             ON a.business_id=d.business_id AND a.id=d.authorization_id
           JOIN facturations_qualified_invoice_documents AS q
             ON q.business_id=d.business_id AND q.id=d.qualified_document_id
           JOIN facturations_issued_invoices AS i
             ON i.business_id=d.business_id AND i.id=d.issued_invoice_id
          WHERE d.business_id=$1 AND d.id=$2
          FOR SHARE OF d,a,q,i`,
        [tenant,attemptId]
      );
      if(!found.rows.length) throw new DeliveryReceiptError('CONFIRMED_DELIVERY_NOT_FOUND',404);
      const row=found.rows[0];
      const snapshotEmail=row.issued_snapshot?.customer?.email;
      if(row.state!=='CONFIRMED' || !row.provider_message_id || !row.provider_confirmed_at){
        throw new DeliveryReceiptError('CONFIRMED_DELIVERY_REQUIRED',409);
      }
      if(row.authorization_state!=='AUTHORIZED_PENDING_DELIVERY' ||
         row.invoice_status!=='ISSUED_CONFIRMED' ||
         row.document_delivery_state!=='NOT_AUTHORIZED' ||
         row.invoice_delivery_state!=='NOT_AUTHORIZED' ||
         row.qualified_document_sha256!==row.content_sha256 ||
         typeof snapshotEmail!=='string' ||
         snapshotEmail.toLowerCase()!==row.expected_recipient_email){
        throw new DeliveryReceiptError('DELIVERY_RECEIPT_PROVENANCE_MISMATCH',409);
      }

      row.receipt_sha256=receiptHash(row);
      const inserted=await client.query(
        `INSERT INTO facturations_delivery_receipts
           (business_id,attempt_id,authorization_id,issued_invoice_id,qualified_document_id,
            qualified_document_sha256,expected_recipient_email,recipient_snapshot_hash,
            provider,provider_message_id,provider_confirmed_at,receipt_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (business_id,attempt_id) DO NOTHING
         RETURNING *`,
        [tenant,row.attempt_id,row.authorization_id,row.issued_invoice_id,
         row.qualified_document_id,row.qualified_document_sha256,row.expected_recipient_email,
         row.recipient_snapshot_hash,row.provider,row.provider_message_id,
         row.provider_confirmed_at,row.receipt_sha256]
      );
      let saved=inserted.rows[0];
      if(!saved){
        const existing=await client.query(
          'SELECT * FROM facturations_delivery_receipts WHERE business_id=$1 AND attempt_id=$2',
          [tenant,attemptId]
        );
        saved=existing.rows[0];
        if(!saved || saved.receipt_sha256!==row.receipt_sha256 ||
           saved.provider_message_id!==row.provider_message_id ||
           saved.qualified_document_sha256!==row.qualified_document_sha256 ||
           saved.expected_recipient_email!==row.expected_recipient_email){
          throw new DeliveryReceiptError('DELIVERY_RECEIPT_CONFLICT',409);
        }
      }
      await client.query('COMMIT');
      transaction=false;
      return asResult(saved);
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  async function getByAttempt(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='attemptId'){
      throw new DeliveryReceiptError('INVALID_RECEIPT_LOOKUP');
    }
    const attemptId=uuid(input.attemptId,'INVALID_ATTEMPT_ID');
    const found=await pool.query(
      'SELECT * FROM facturations_delivery_receipts WHERE business_id=$1 AND attempt_id=$2',
      [tenant,attemptId]
    );
    if(!found.rows.length) throw new DeliveryReceiptError('DELIVERY_RECEIPT_NOT_FOUND',404);
    return asResult(found.rows[0]);
  }

  return Object.freeze({materialize,getByAttempt});
}

module.exports={createDeliveryReceiptStore,DeliveryReceiptError};
