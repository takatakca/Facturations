'use strict';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class EmailEvidenceSummaryError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='EmailEvidenceSummaryError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new EmailEvidenceSummaryError(code);
  return value.toLowerCase();
}

function iso(value){
  if(value==null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function resultOf(row){
  const hasSignedWebhook=row.has_signed_webhook===true;
  return Object.freeze({
    qualifiedDocumentId:row.qualified_document_id,
    providerKey:row.provider_key,
    providerMessageId:row.provider_message_id,
    eventCount:Number(row.event_count),
    firstEventAt:iso(row.first_event_at),
    latestEventAt:iso(row.latest_event_at),
    latestEventType:row.latest_event_type,
    hasDelivered:row.has_delivered===true,
    hasBounced:row.has_bounced===true,
    hasComplaint:row.has_complaint===true,
    lastDeliveredAt:iso(row.last_delivered_at),
    lastBouncedAt:iso(row.last_bounced_at),
    lastComplaintAt:iso(row.last_complaint_at),
    proofScope:hasSignedWebhook ? 'SIGNED_WEBHOOK_PRESENT' : 'SYNTHETIC_ONLY',
    syntheticOnly:row.synthetic_only===true,
    hasSignedWebhook,
  });
}

function createEmailEvidenceSummaryStore({pool,businessId}={}){
  if(!pool || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function getByQualifiedDocument(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='qualifiedDocumentId'){
      throw new EmailEvidenceSummaryError('INVALID_EVIDENCE_SUMMARY_LOOKUP');
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const found=await pool.query(
      `SELECT *
         FROM facturations_email_provider_evidence_summary
        WHERE business_id=$1 AND qualified_document_id=$2
        ORDER BY latest_event_at DESC,provider_key,provider_message_id`,
      [tenant,qualifiedDocumentId]
    );
    return Object.freeze(found.rows.map(resultOf));
  }

  return Object.freeze({getByQualifiedDocument});
}

module.exports={
  createEmailEvidenceSummaryStore,
  EmailEvidenceSummaryError,
};
