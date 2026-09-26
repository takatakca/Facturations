'use strict';

const crypto=require('node:crypto');
const {
  normalizeEmailProviderEvidenceEvent,
  EmailProviderContractError,
} = require('./email-provider-contract');

const PROVIDER_KEY=/^[A-Z][A-Z0-9_]{1,63}$/;
const verifiedEnvelopes=new WeakSet();

class EmailWebhookVerificationError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='EmailWebhookVerificationError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function providerKey(value){
  if(typeof value!=='string' || !PROVIDER_KEY.test(value)){
    throw new EmailWebhookVerificationError('INVALID_PROVIDER_KEY');
  }
  return value;
}

function normalizeHeaders(value){
  if(!value || typeof value!=='object' || Array.isArray(value)){
    throw new EmailWebhookVerificationError('INVALID_WEBHOOK_HEADERS');
  }
  const output={};
  for(const [key,raw] of Object.entries(value)){
    const name=key.toLowerCase();
    if(!/^[a-z0-9-]{1,80}$/u.test(name)){
      throw new EmailWebhookVerificationError('INVALID_WEBHOOK_HEADERS');
    }
    if(typeof raw==='string'){
      if(raw.length>4096 || /[\u0000\r\n]/u.test(raw)){
        throw new EmailWebhookVerificationError('INVALID_WEBHOOK_HEADERS');
      }
      output[name]=raw;
      continue;
    }
    if(Array.isArray(raw) && raw.length>0 && raw.length<=20 &&
       raw.every(item=>typeof item==='string' && item.length<=4096 && !/[\u0000\r\n]/u.test(item))){
      output[name]=Object.freeze([...raw]);
      continue;
    }
    throw new EmailWebhookVerificationError('INVALID_WEBHOOK_HEADERS');
  }
  return Object.freeze(output);
}

function validateWebhookInput(input){
  if(!input || typeof input!=='object' || Array.isArray(input) ||
     Object.keys(input).sort().join(',')!=='headers,rawBody'){
    throw new EmailWebhookVerificationError('INVALID_WEBHOOK_VERIFICATION_REQUEST');
  }
  if(!Buffer.isBuffer(input.rawBody) || input.rawBody.length<1 || input.rawBody.length>1_048_576){
    throw new EmailWebhookVerificationError('INVALID_WEBHOOK_RAW_BODY');
  }
  return Object.freeze({
    headers:normalizeHeaders(input.headers),
    rawBody:Buffer.from(input.rawBody),
  });
}

function isVerifiedEmailWebhookEnvelope(value){
  return !!value && typeof value==='object' && verifiedEnvelopes.has(value);
}

function createEmailWebhookVerifier({providerKey:configuredProviderKey,verifyAndParse}={}){
  const key=providerKey(configuredProviderKey);
  if(typeof verifyAndParse!=='function'){
    throw new TypeError('Provider-specific webhook verifier required');
  }

  async function verify(input){
    const request=validateWebhookInput(input);
    let parsed;
    try{
      parsed=await verifyAndParse(Object.freeze({
        providerKey:key,
        headers:request.headers,
        rawBody:Buffer.from(request.rawBody),
      }));
    }catch{
      throw new EmailWebhookVerificationError('WEBHOOK_SIGNATURE_VERIFICATION_FAILED',401);
    }

    let evidence;
    try{
      evidence=normalizeEmailProviderEvidenceEvent(parsed);
    }catch(error){
      if(error instanceof EmailProviderContractError){
        throw new EmailWebhookVerificationError('VERIFIED_WEBHOOK_EVENT_INVALID',422);
      }
      throw error;
    }
    if(evidence.providerKey!==key){
      throw new EmailWebhookVerificationError('PROVIDER_KEY_MISMATCH',409);
    }

    const envelope=Object.freeze({
      providerKey:key,
      evidence,
      rawBodySha256:crypto.createHash('sha256').update(request.rawBody).digest('hex'),
    });
    verifiedEnvelopes.add(envelope);
    return envelope;
  }

  return Object.freeze({providerKey:key,verify});
}

module.exports={
  createEmailWebhookVerifier,
  EmailWebhookVerificationError,
  isVerifiedEmailWebhookEnvelope,
};
