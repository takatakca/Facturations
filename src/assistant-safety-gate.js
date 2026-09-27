'use strict';

const crypto = require('node:crypto');

const SOURCES = new Set(['TEXT','VOICE']);
const LANGUAGES = new Set(['fr','en']);
const INTENTS = new Set([
  'HELP',
  'READ_STATUS',
  'DRAFT_CHANGE',
  'ISSUE_INVOICE',
  'DELIVER_INVOICE',
  'PUBLISH_PORTAL',
  'RECORD_PAYMENT',
  'REFUND_PAYMENT',
  'MFA_RECOVERY',
]);
const SIGNALS = new Set([
  'PROMPT_INJECTION',
  'MULTI_ACTION',
  'AMBIGUOUS_TARGET',
  'UNVERIFIED_TRANSCRIPT',
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256=/^[a-f0-9]{64}$/u;

class AssistantSafetyError extends Error {
  constructor(code,statusCode=422){
    super(code);
    this.name='AssistantSafetyError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function exactObject(value,keys,code){
  if(!value || typeof value!=='object' || Array.isArray(value)){
    throw new AssistantSafetyError(code);
  }
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length ||
      actual.some((key,index)=>key!==expected[index])){
    throw new AssistantSafetyError(code);
  }
}

function normalizeSignals(value){
  if(!Array.isArray(value) || value.length>8){
    throw new AssistantSafetyError('INVALID_SAFETY_SIGNALS');
  }
  const unique=[];
  for(const signal of value){
    if(typeof signal!=='string' || !SIGNALS.has(signal)){
      throw new AssistantSafetyError('INVALID_SAFETY_SIGNAL');
    }
    if(!unique.includes(signal)) unique.push(signal);
  }
  return unique.sort();
}

function normalizeTarget(value){
  exactObject(value,['type','id'],'INVALID_ASSISTANT_TARGET');
  if(!['NONE','DRAFT','ISSUED_INVOICE','QUALIFIED_DOCUMENT'].includes(value.type)){
    throw new AssistantSafetyError('INVALID_ASSISTANT_TARGET');
  }
  if(value.type==='NONE'){
    if(value.id!==null) throw new AssistantSafetyError('INVALID_ASSISTANT_TARGET');
    return Object.freeze({type:'NONE',id:null});
  }
  if(typeof value.id!=='string' || !UUID.test(value.id)){
    throw new AssistantSafetyError('INVALID_ASSISTANT_TARGET');
  }
  return Object.freeze({type:value.type,id:value.id.toLowerCase()});
}

function normalizeTranscriptEvidence(source,value){
  if(source==='TEXT'){
    if(value!==null) throw new AssistantSafetyError('TEXT_TRANSCRIPT_EVIDENCE_FORBIDDEN');
    return null;
  }
  exactObject(value,['sha256','length','language'],'INVALID_VOICE_TRANSCRIPT_EVIDENCE');
  if(typeof value.sha256!=='string' || !SHA256.test(value.sha256) ||
      !Number.isInteger(value.length) || value.length<1 || value.length>20000 ||
      typeof value.language!=='string' || !LANGUAGES.has(value.language)){
    throw new AssistantSafetyError('INVALID_VOICE_TRANSCRIPT_EVIDENCE');
  }
  return Object.freeze({
    sha256:value.sha256,
    length:value.length,
    language:value.language,
  });
}

function fingerprint(payload){
  const canonical=JSON.stringify(payload);
  return crypto.createHash('sha256')
    .update('facturations-assistant-proposal-v1\0')
    .update(canonical)
    .digest('hex');
}

function evaluateAssistantProposal(input){
  exactObject(input,[
    'version','source','intent','confidenceBps','target',
    'transcriptEvidence','safetySignals'
  ],'INVALID_ASSISTANT_PROPOSAL');

  if(input.version!==1) throw new AssistantSafetyError('UNSUPPORTED_ASSISTANT_PROPOSAL_VERSION');
  if(typeof input.source!=='string' || !SOURCES.has(input.source)){
    throw new AssistantSafetyError('INVALID_ASSISTANT_SOURCE');
  }
  if(typeof input.intent!=='string' || !INTENTS.has(input.intent)){
    throw new AssistantSafetyError('INVALID_ASSISTANT_INTENT');
  }
  if(!Number.isInteger(input.confidenceBps) ||
      input.confidenceBps<0 || input.confidenceBps>10000){
    throw new AssistantSafetyError('INVALID_ASSISTANT_CONFIDENCE');
  }

  const target=normalizeTarget(input.target);
  const transcriptEvidence=normalizeTranscriptEvidence(input.source,input.transcriptEvidence);
  const safetySignals=normalizeSignals(input.safetySignals);

  const normalized=Object.freeze({
    version:1,
    source:input.source,
    intent:input.intent,
    confidenceBps:input.confidenceBps,
    target,
    transcriptEvidence,
    safetySignals:Object.freeze([...safetySignals]),
  });
  const proposalFingerprint=fingerprint(normalized);

  if(safetySignals.length){
    return Object.freeze({
      decision:'BLOCKED',
      reasonCode:'SAFETY_SIGNAL_PRESENT',
      requiredGate:null,
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  const threshold=input.source==='VOICE' ? 9000 : 8000;
  if(input.confidenceBps<threshold){
    return Object.freeze({
      decision:'BLOCKED',
      reasonCode:'LOW_CONFIDENCE',
      requiredGate:null,
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='HELP'){
    if(target.type!=='NONE'){
      throw new AssistantSafetyError('HELP_TARGET_FORBIDDEN');
    }
    return Object.freeze({
      decision:'READ_ONLY_ALLOWED',
      reasonCode:'HELP_ONLY',
      requiredGate:null,
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='READ_STATUS'){
    if(!['DRAFT','ISSUED_INVOICE','QUALIFIED_DOCUMENT'].includes(target.type)){
      throw new AssistantSafetyError('READ_TARGET_REQUIRED');
    }
    return Object.freeze({
      decision:'READ_ONLY_ALLOWED',
      reasonCode:'READ_ONLY_QUERY',
      requiredGate:null,
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='DRAFT_CHANGE'){
    if(target.type!=='DRAFT') throw new AssistantSafetyError('DRAFT_TARGET_REQUIRED');
    return Object.freeze({
      decision:'PROPOSAL_ONLY',
      reasonCode:'HUMAN_DRAFT_REVIEW_REQUIRED',
      requiredGate:'DRAFT_EDITOR_REVIEW',
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='ISSUE_INVOICE'){
    if(target.type!=='DRAFT') throw new AssistantSafetyError('DRAFT_TARGET_REQUIRED');
    return Object.freeze({
      decision:'REQUIRES_EXISTING_GATE',
      reasonCode:'OWNER_ISSUANCE_AUTHORIZATION_REQUIRED',
      requiredGate:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='DELIVER_INVOICE'){
    if(target.type!=='QUALIFIED_DOCUMENT'){
      throw new AssistantSafetyError('QUALIFIED_DOCUMENT_TARGET_REQUIRED');
    }
    return Object.freeze({
      decision:'REQUIRES_EXISTING_GATE',
      reasonCode:'OWNER_DELIVERY_AUTHORIZATION_REQUIRED',
      requiredGate:'AUTHORIZE_QUALIFIED_PDF_DELIVERY',
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='PUBLISH_PORTAL'){
    if(target.type!=='ISSUED_INVOICE'){
      throw new AssistantSafetyError('ISSUED_INVOICE_TARGET_REQUIRED');
    }
    return Object.freeze({
      decision:'REQUIRES_EXISTING_GATE',
      reasonCode:'OWNER_PORTAL_PUBLICATION_REQUIRED',
      requiredGate:'CLIENT_PORTAL_PUBLICATION',
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  if(input.intent==='MFA_RECOVERY'){
    return Object.freeze({
      decision:'BLOCKED',
      reasonCode:'MFA_RECOVERY_OUT_OF_BAND_ONLY',
      requiredGate:'HUMAN_OUT_OF_BAND',
      proposalFingerprint,
      directExecutionAllowed:false,
    });
  }

  return Object.freeze({
    decision:'BLOCKED',
    reasonCode:'REAL_FINANCIAL_PROVIDER_NOT_AVAILABLE',
    requiredGate:'REAL_PROVIDER',
    proposalFingerprint,
    directExecutionAllowed:false,
  });
}

module.exports={
  evaluateAssistantProposal,
  AssistantSafetyError,
  ASSISTANT_INTENTS:INTENTS,
  ASSISTANT_SAFETY_SIGNALS:SIGNALS,
};
