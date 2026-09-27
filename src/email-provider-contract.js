'use strict';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const HASH = /^[a-f0-9]{64}$/;
const OPERATION_KEY = /^[A-Za-z0-9_-]{24,120}$/;
const PROVIDER_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const EVENT_ID = /^[A-Za-z0-9._:@/-]{1,200}$/;
const MESSAGE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVIDENCE_EVENTS = new Set(['DELIVERED','BOUNCED','COMPLAINT']);

class EmailProviderContractError extends Error {
  constructor(code,statusCode=422){
    super(code);
    this.name='EmailProviderContractError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function exactKeys(input,expected,code){
  if(!input || typeof input!=='object' || Array.isArray(input) ||
     Object.keys(input).sort().join(',')!==[...expected].sort().join(',')){
    throw new EmailProviderContractError(code);
  }
}

function text(value,max,code){
  if(typeof value!=='string'){
    throw new EmailProviderContractError(code);
  }
  const normalized=value.trim();
  if(!normalized || normalized.length>max || /[\u0000-\u001f\u007f]/u.test(normalized)){
    throw new EmailProviderContractError(code);
  }
  return normalized;
}

function email(value){
  const normalized=text(value,254,'INVALID_PROVIDER_RECIPIENT').toLowerCase();
  if(!EMAIL.test(normalized)) throw new EmailProviderContractError('INVALID_PROVIDER_RECIPIENT');
  return normalized;
}

function providerKey(value){
  if(typeof value!=='string' || !PROVIDER_KEY.test(value)){
    throw new EmailProviderContractError('INVALID_PROVIDER_KEY');
  }
  return value;
}

function operationKey(value){
  if(typeof value!=='string' || !OPERATION_KEY.test(value)){
    throw new EmailProviderContractError('INVALID_OPERATION_KEY');
  }
  return value;
}

function hash(value,code){
  if(typeof value!=='string' || !HASH.test(value)){
    throw new EmailProviderContractError(code);
  }
  return value;
}

function isoInstant(value,code){
  if(typeof value!=='string') throw new EmailProviderContractError(code);
  const instant=new Date(value);
  if(Number.isNaN(instant.getTime()) || instant.toISOString()!==value){
    throw new EmailProviderContractError(code);
  }
  return value;
}

function validateEmailSubmission(input){
  exactKeys(input,[
    'operationKey','recipientEmail','subject','filename','contentType',
    'pdfBytes','qualifiedDocumentId','qualifiedDocumentSha256'
  ],'INVALID_EMAIL_PROVIDER_SUBMISSION');

  const pdf=input.pdfBytes;
  if(!Buffer.isBuffer(pdf) || pdf.length<100 || pdf.length>2_097_152 ||
     pdf.subarray(0,5).toString('ascii')!=='%PDF-' ||
     !pdf.subarray(Math.max(0,pdf.length-32)).toString('ascii').includes('%%EOF')){
    throw new EmailProviderContractError('INVALID_EMAIL_PROVIDER_PDF');
  }

  const qualifiedDocumentId=text(
    input.qualifiedDocumentId,64,'INVALID_QUALIFIED_DOCUMENT_ID'
  );
  const subject=text(input.subject,200,'INVALID_EMAIL_SUBJECT');
  const filename=text(input.filename,160,'INVALID_EMAIL_FILENAME');
  if(!/^[^/\\]+\.pdf$/iu.test(filename)){
    throw new EmailProviderContractError('INVALID_EMAIL_FILENAME');
  }
  if(input.contentType!=='application/pdf'){
    throw new EmailProviderContractError('INVALID_EMAIL_CONTENT_TYPE');
  }

  return Object.freeze({
    operationKey:operationKey(input.operationKey),
    recipientEmail:email(input.recipientEmail),
    subject,
    filename,
    contentType:'application/pdf',
    pdfBytes:Buffer.from(pdf),
    qualifiedDocumentId,
    qualifiedDocumentSha256:hash(
      input.qualifiedDocumentSha256,'INVALID_QUALIFIED_DOCUMENT_SHA256'
    ),
  });
}

function normalizeSubmissionResult(result){
  if(!result || typeof result!=='object' || Array.isArray(result) ||
     typeof result.status!=='string'){
    return Object.freeze({status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'});
  }
  if(result.status==='ACCEPTED'){
    if(typeof result.providerMessageId!=='string' || !MESSAGE_ID.test(result.providerMessageId)){
      return Object.freeze({status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'});
    }
    return Object.freeze({
      status:'ACCEPTED',
      providerMessageId:result.providerMessageId,
    });
  }
  if(result.status==='FAILED' || result.status==='AMBIGUOUS'){
    if(typeof result.reasonCode!=='string' || !CODE.test(result.reasonCode)){
      return Object.freeze({status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'});
    }
    return Object.freeze({status:result.status,reasonCode:result.reasonCode});
  }
  return Object.freeze({status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'});
}

function normalizeEvidenceEvent(input){
  try{
    exactKeys(input,[
      'providerKey','eventId','providerMessageId','eventType','occurredAt','recipientEmail'
    ],'INVALID_PROVIDER_EVIDENCE_EVENT');
    const type=input.eventType;
    if(!EVIDENCE_EVENTS.has(type)){
      throw new EmailProviderContractError('INVALID_PROVIDER_EVIDENCE_TYPE');
    }
    if(typeof input.eventId!=='string' || !EVENT_ID.test(input.eventId)){
      throw new EmailProviderContractError('INVALID_PROVIDER_EVENT_ID');
    }
    if(typeof input.providerMessageId!=='string' || !MESSAGE_ID.test(input.providerMessageId)){
      throw new EmailProviderContractError('INVALID_PROVIDER_MESSAGE_ID');
    }
    return Object.freeze({
      providerKey:providerKey(input.providerKey),
      eventId:input.eventId,
      providerMessageId:input.providerMessageId,
      eventType:type,
      occurredAt:isoInstant(input.occurredAt,'INVALID_PROVIDER_EVENT_TIME'),
      recipientEmail:email(input.recipientEmail),
    });
  }catch(error){
    if(error instanceof EmailProviderContractError) throw error;
    throw new EmailProviderContractError('INVALID_PROVIDER_EVIDENCE_EVENT');
  }
}

function createEmailProviderContract({providerKey:configuredProviderKey,adapter}={}){
  const key=providerKey(configuredProviderKey);
  if(!adapter || typeof adapter.submit!=='function'){
    throw new TypeError('Injected staging email provider adapter required');
  }

  async function submit(input){
    const submission=validateEmailSubmission(input);
    let result;
    try{
      result=await adapter.submit(Object.freeze({
        providerKey:key,
        operationKey:submission.operationKey,
        recipientEmail:submission.recipientEmail,
        subject:submission.subject,
        filename:submission.filename,
        contentType:submission.contentType,
        pdfBytes:Buffer.from(submission.pdfBytes),
        qualifiedDocumentId:submission.qualifiedDocumentId,
        qualifiedDocumentSha256:submission.qualifiedDocumentSha256,
      }));
    }catch{
      return Object.freeze({status:'AMBIGUOUS',reasonCode:'PROVIDER_EXCEPTION'});
    }
    return normalizeSubmissionResult(result);
  }

  function evidence(input){
    const normalized=normalizeEvidenceEvent(input);
    if(normalized.providerKey!==key){
      throw new EmailProviderContractError('PROVIDER_KEY_MISMATCH',409);
    }
    return normalized;
  }

  return Object.freeze({providerKey:key,submit,evidence});
}

module.exports={
  createEmailProviderContract,
  EmailProviderContractError,
  validateEmailProviderSubmission:validateEmailSubmission,
  normalizeEmailProviderSubmissionResult:normalizeSubmissionResult,
  normalizeEmailProviderEvidenceEvent:normalizeEvidenceEvent,
  EMAIL_PROVIDER_EVIDENCE_EVENTS:Object.freeze([...EVIDENCE_EVENTS]),
};
