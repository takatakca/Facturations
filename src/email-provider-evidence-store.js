'use strict';

const crypto=require('node:crypto');
const {
  normalizeEmailProviderEvidenceEvent,
  EmailProviderContractError,
} = require('./email-provider-contract');
const {
  isVerifiedEmailWebhookEnvelope,
} = require('./email-webhook-verification');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPERATION_KEY=/^[A-Za-z0-9_-]{24,120}$/;
const PROVIDER_KEY=/^[A-Z][A-Z0-9_]{1,63}$/;
const VERIFICATION_SCHEME=/^[A-Z0-9][A-Z0-9_.:-]{0,119}$/;

class EmailProviderEvidenceError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='EmailProviderEvidenceError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new EmailProviderEvidenceError(code);
  return value.toLowerCase();
}

function operationKey(value){
  if(typeof value!=='string' || !OPERATION_KEY.test(value)){
    throw new EmailProviderEvidenceError('INVALID_OPERATION_KEY');
  }
  return value;
}

function providerKey(value){
  if(typeof value!=='string' || !PROVIDER_KEY.test(value)){
    throw new EmailProviderEvidenceError('INVALID_PROVIDER_KEY');
  }
  return value;
}

function verificationScheme(value){
  if(typeof value!=='string' || !VERIFICATION_SCHEME.test(value)){
    throw new EmailProviderEvidenceError('INVALID_VERIFICATION_SCHEME');
  }
  return value;
}

function canonicalEvidence({
  qualifiedDocumentId,
  qualifiedDocumentSha256,
  operationKey,
  event,
  sourceMode,
  webhookBodySha256,
  verificationScheme,
}){
  const canonical={
    qualifiedDocumentId,
    qualifiedDocumentSha256,
    operationKey,
    providerKey:event.providerKey,
    providerMessageId:event.providerMessageId,
    providerEventId:event.eventId,
    eventType:event.eventType,
    occurredAt:event.occurredAt,
    recipientEmail:event.recipientEmail,
    sourceMode,
  };
  if(sourceMode==='SIGNED_WEBHOOK'){
    canonical.webhookBodySha256=webhookBodySha256;
    canonical.verificationScheme=verificationScheme;
  }
  return canonical;
}

function evidenceHash(fields){
  return crypto.createHash('sha256')
    .update('facturations-email-provider-evidence-v1\0')
    .update(JSON.stringify(canonicalEvidence(fields)))
    .digest('hex');
}

function resultOf(row){
  const signed=row.source_mode==='SIGNED_WEBHOOK';
  return Object.freeze({
    id:row.id,
    qualifiedDocumentId:row.qualified_document_id,
    qualifiedDocumentSha256:row.qualified_document_sha256,
    operationKey:row.operation_key,
    providerKey:row.provider_key,
    providerMessageId:row.provider_message_id,
    providerEventId:row.provider_event_id,
    eventType:row.event_type,
    occurredAt:row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    recipientEmail:row.recipient_email,
    sourceMode:row.source_mode,
    webhookBodySha256:row.webhook_body_sha256 || null,
    verificationScheme:row.verification_scheme || null,
    evidenceHash:row.evidence_hash,
    recordedAt:row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
    signatureVerified:signed,
    realWebhookVerified:signed,
  });
}

function createEmailProviderEvidenceStore({pool,businessId,providerKey:configuredProviderKey}={}){
  if(!pool || typeof pool.connect!=='function' || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();
  const provider=providerKey(configuredProviderKey);

  async function listByQualifiedDocument(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='qualifiedDocumentId'){
      throw new EmailProviderEvidenceError('INVALID_EVIDENCE_LOOKUP');
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const found=await pool.query(
      `SELECT * FROM facturations_email_provider_evidence
        WHERE business_id=$1 AND qualified_document_id=$2
        ORDER BY occurred_at,id`,
      [tenant,qualifiedDocumentId]
    );
    return Object.freeze(found.rows.map(resultOf));
  }

  async function persist({
    qualifiedDocumentId,
    opKey,
    event,
    sourceMode,
    webhookBodySha256=null,
    verificationScheme:scheme=null,
  }){
    if(event.providerKey!==provider){
      throw new EmailProviderEvidenceError('PROVIDER_KEY_MISMATCH',409);
    }

    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;
      const chain=await client.query(
        `SELECT q.id,q.content_sha256,q.delivery_state,
                i.status AS invoice_status,i.issued_snapshot
           FROM facturations_qualified_invoice_documents AS q
           JOIN facturations_issued_invoices AS i
             ON i.business_id=q.business_id AND i.id=q.issued_invoice_id
          WHERE q.business_id=$1 AND q.id=$2
          FOR SHARE OF q,i`,
        [tenant,qualifiedDocumentId]
      );
      if(!chain.rows.length) throw new EmailProviderEvidenceError('QUALIFIED_DOCUMENT_NOT_FOUND',404);
      const row=chain.rows[0];

      if(row.invoice_status!=='ISSUED_CONFIRMED' || row.delivery_state!=='NOT_AUTHORIZED'){
        throw new EmailProviderEvidenceError('EVIDENCE_SOURCE_NOT_READY',409);
      }
      const recipient=row.issued_snapshot?.customer?.email;
      if(typeof recipient!=='string' || recipient.trim().toLowerCase()!==event.recipientEmail){
        throw new EmailProviderEvidenceError('EVIDENCE_RECIPIENT_MISMATCH',409);
      }

      const fields={
        qualifiedDocumentId,
        qualifiedDocumentSha256:row.content_sha256,
        operationKey:opKey,
        event,
        sourceMode,
        webhookBodySha256,
        verificationScheme:scheme,
      };
      const hash=evidenceHash(fields);
      const inserted=await client.query(
        `INSERT INTO facturations_email_provider_evidence
           (business_id,qualified_document_id,qualified_document_sha256,operation_key,
            provider_key,provider_message_id,provider_event_id,event_type,occurred_at,
            recipient_email,source_mode,evidence_hash,webhook_body_sha256,verification_scheme)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (business_id,provider_key,provider_event_id) DO NOTHING
         RETURNING *`,
        [
          tenant,
          qualifiedDocumentId,
          row.content_sha256,
          opKey,
          event.providerKey,
          event.providerMessageId,
          event.eventId,
          event.eventType,
          event.occurredAt,
          event.recipientEmail,
          sourceMode,
          hash,
          webhookBodySha256,
          scheme,
        ]
      );

      let saved=inserted.rows[0];
      if(!saved){
        const prior=await client.query(
          `SELECT * FROM facturations_email_provider_evidence
            WHERE business_id=$1 AND provider_key=$2 AND provider_event_id=$3`,
          [tenant,event.providerKey,event.eventId]
        );
        saved=prior.rows[0];
        if(!saved ||
           saved.qualified_document_id!==qualifiedDocumentId ||
           saved.qualified_document_sha256!==row.content_sha256 ||
           saved.operation_key!==opKey ||
           saved.provider_message_id!==event.providerMessageId ||
           saved.event_type!==event.eventType ||
           new Date(saved.occurred_at).toISOString()!==event.occurredAt ||
           saved.recipient_email!==event.recipientEmail ||
           saved.source_mode!==sourceMode ||
           (saved.webhook_body_sha256 || null)!==webhookBodySha256 ||
           (saved.verification_scheme || null)!==scheme ||
           saved.evidence_hash!==hash){
          throw new EmailProviderEvidenceError('EVIDENCE_EVENT_CONFLICT',409);
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

  async function ingestSynthetic(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='event,operationKey,qualifiedDocumentId'){
      throw new EmailProviderEvidenceError('INVALID_SYNTHETIC_EVIDENCE_REQUEST');
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const opKey=operationKey(input.operationKey);

    let event;
    try{
      event=normalizeEmailProviderEvidenceEvent(input.event);
    }catch(error){
      if(error instanceof EmailProviderContractError){
        throw new EmailProviderEvidenceError(error.code,error.statusCode);
      }
      throw error;
    }

    return persist({
      qualifiedDocumentId,
      opKey,
      event,
      sourceMode:'SYNTHETIC_TEST',
    });
  }

  async function ingestVerifiedWebhook(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!==
         'operationKey,qualifiedDocumentId,verificationScheme,verifiedEnvelope'){
      throw new EmailProviderEvidenceError('INVALID_VERIFIED_WEBHOOK_REQUEST');
    }
    if(!isVerifiedEmailWebhookEnvelope(input.verifiedEnvelope)){
      throw new EmailProviderEvidenceError('VERIFIED_WEBHOOK_ENVELOPE_REQUIRED',403);
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const opKey=operationKey(input.operationKey);
    const scheme=verificationScheme(input.verificationScheme);
    const envelope=input.verifiedEnvelope;

    if(envelope.providerKey!==provider){
      throw new EmailProviderEvidenceError('PROVIDER_KEY_MISMATCH',409);
    }
    if(typeof envelope.rawBodySha256!=='string' ||
       !/^[a-f0-9]{64}$/u.test(envelope.rawBodySha256)){
      throw new EmailProviderEvidenceError('INVALID_VERIFIED_WEBHOOK_BODY_HASH',409);
    }

    return persist({
      qualifiedDocumentId,
      opKey,
      event:envelope.evidence,
      sourceMode:'SIGNED_WEBHOOK',
      webhookBodySha256:envelope.rawBodySha256,
      verificationScheme:scheme,
    });
  }

  return Object.freeze({
    providerKey:provider,
    ingestSynthetic,
    ingestVerifiedWebhook,
    listByQualifiedDocument,
  });
}

module.exports={
  createEmailProviderEvidenceStore,
  EmailProviderEvidenceError,
};
