'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {
  createEmailProviderContract,
  EmailProviderContractError,
  validateEmailProviderSubmission,
  normalizeEmailProviderSubmissionResult,
  normalizeEmailProviderEvidenceEvent,
} = require('../src/email-provider-contract');

function pdf(){
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n','ascii'),
    Buffer.alloc(180,65),
    Buffer.from('\n%%EOF\n','ascii'),
  ]);
}

function submission(){
  return {
    operationKey:'mail_' + crypto.randomBytes(32).toString('base64url'),
    recipientEmail:'Client@Example.Test',
    subject:'Votre facture / Your invoice',
    filename:'invoice-SYNTHETIC-001.pdf',
    contentType:'application/pdf',
    pdfBytes:pdf(),
    qualifiedDocumentId:'11111111-1111-4111-8111-111111111111',
    qualifiedDocumentSha256:'a'.repeat(64),
  };
}

test('staging provider submission preserves exact idempotency and immutable document provenance',async()=>{
  let seen;
  const contract=createEmailProviderContract({
    providerKey:'STAGING_EMAIL',
    adapter:{
      async submit(input){
        seen=input;
        return {status:'ACCEPTED',providerMessageId:'staging-message-001'};
      },
    },
  });
  const result=await contract.submit(submission());
  assert.equal(contract.providerKey,'STAGING_EMAIL');
  assert.equal(result.status,'ACCEPTED');
  assert.equal(result.providerMessageId,'staging-message-001');
  assert.ok(seen.operationKey.startsWith('mail_'));
  assert.equal(seen.recipientEmail,'client@example.test');
  assert.equal(seen.qualifiedDocumentSha256,'a'.repeat(64));
  assert.ok(Buffer.isBuffer(seen.pdfBytes));
});

test('provider exceptions and malformed results fail ambiguous instead of pretending delivery',async()=>{
  const throwing=createEmailProviderContract({
    providerKey:'STAGING_EMAIL',
    adapter:{async submit(){throw new Error('synthetic network failure');}},
  });
  assert.deepEqual(
    await throwing.submit(submission()),
    {status:'AMBIGUOUS',reasonCode:'PROVIDER_EXCEPTION'}
  );

  assert.deepEqual(
    normalizeEmailProviderSubmissionResult({status:'ACCEPTED'}),
    {status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'}
  );
  assert.deepEqual(
    normalizeEmailProviderSubmissionResult({status:'DELIVERED',providerMessageId:'x'}),
    {status:'AMBIGUOUS',reasonCode:'PROVIDER_RESULT_INVALID'}
  );
});

test('submission validator rejects non-PDF bytes and content hash shape errors',()=>{
  const badPdf={...submission(),pdfBytes:Buffer.from('not a pdf')};
  assert.throws(
    ()=>validateEmailProviderSubmission(badPdf),
    error=>error instanceof EmailProviderContractError &&
      error.code==='INVALID_EMAIL_PROVIDER_PDF'
  );

  const badHash={...submission(),qualifiedDocumentSha256:'nope'};
  assert.throws(
    ()=>validateEmailProviderSubmission(badHash),
    error=>error instanceof EmailProviderContractError &&
      error.code==='INVALID_QUALIFIED_DOCUMENT_SHA256'
  );
});

test('evidence contract distinguishes delivered, bounced and complaint with exact provider identity',()=>{
  const base={
    providerKey:'STAGING_EMAIL',
    eventId:'event-001',
    providerMessageId:'staging-message-001',
    occurredAt:'2026-09-26T16:00:00.000Z',
    recipientEmail:'client@example.test',
  };
  for(const eventType of ['DELIVERED','BOUNCED','COMPLAINT']){
    const event=normalizeEmailProviderEvidenceEvent({...base,eventId:'event-'+eventType,eventType});
    assert.equal(event.eventType,eventType);
  }

  const contract=createEmailProviderContract({
    providerKey:'STAGING_EMAIL',
    adapter:{async submit(){return {status:'FAILED',reasonCode:'SYNTHETIC_REJECTED'};}},
  });
  assert.throws(
    ()=>contract.evidence({...base,providerKey:'OTHER_PROVIDER',eventType:'DELIVERED'}),
    error=>error instanceof EmailProviderContractError &&
      error.code==='PROVIDER_KEY_MISMATCH' &&
      error.statusCode===409
  );
});

test('ACCEPTED is not normalized as DELIVERED evidence',()=>{
  const base={
    providerKey:'STAGING_EMAIL',
    eventId:'event-accepted',
    providerMessageId:'staging-message-001',
    eventType:'ACCEPTED',
    occurredAt:'2026-09-26T16:00:00.000Z',
    recipientEmail:'client@example.test',
  };
  assert.throws(
    ()=>normalizeEmailProviderEvidenceEvent(base),
    error=>error instanceof EmailProviderContractError &&
      error.code==='INVALID_PROVIDER_EVIDENCE_TYPE'
  );
});
