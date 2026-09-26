'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  createEmailWebhookVerifier,
  EmailWebhookVerificationError,
  isVerifiedEmailWebhookEnvelope,
} = require('../src/email-webhook-verification');

function event(){
  return {
    providerKey:'TEST_SIGNED_PROVIDER',
    eventId:'event-delivered-001',
    providerMessageId:'message-001',
    eventType:'DELIVERED',
    occurredAt:'2026-09-26T16:45:00.000Z',
    recipientEmail:'client@example.test',
  };
}

test('verified webhook envelope is branded only after provider-specific verifier succeeds',async()=>{
  let seen;
  const verifier=createEmailWebhookVerifier({
    providerKey:'TEST_SIGNED_PROVIDER',
    async verifyAndParse(input){
      seen=input;
      assert.equal(input.providerKey,'TEST_SIGNED_PROVIDER');
      assert.equal(input.headers['x-test-signature'],'valid');
      assert.ok(Buffer.isBuffer(input.rawBody));
      return event();
    },
  });

  const envelope=await verifier.verify({
    headers:{'X-Test-Signature':'valid'},
    rawBody:Buffer.from('{"synthetic":true}','utf8'),
  });

  assert.equal(envelope.providerKey,'TEST_SIGNED_PROVIDER');
  assert.equal(envelope.evidence.eventType,'DELIVERED');
  assert.match(envelope.rawBodySha256,/^[a-f0-9]{64}$/);
  assert.equal(isVerifiedEmailWebhookEnvelope(envelope),true);
  assert.equal(isVerifiedEmailWebhookEnvelope({...envelope}),false);
  assert.equal(isVerifiedEmailWebhookEnvelope({evidence:event()}),false);
  assert.equal(seen.headers['x-test-signature'],'valid');
});

test('provider verifier failure fails closed with 401 and produces no verified envelope',async()=>{
  const verifier=createEmailWebhookVerifier({
    providerKey:'TEST_SIGNED_PROVIDER',
    async verifyAndParse(){
      throw new Error('bad signature');
    },
  });

  await assert.rejects(
    verifier.verify({
      headers:{'x-test-signature':'bad'},
      rawBody:Buffer.from('payload'),
    }),
    error=>error instanceof EmailWebhookVerificationError &&
      error.code==='WEBHOOK_SIGNATURE_VERIFICATION_FAILED' &&
      error.statusCode===401
  );
});

test('provider-specific verifier cannot return malformed or mismatched evidence',async()=>{
  const malformed=createEmailWebhookVerifier({
    providerKey:'TEST_SIGNED_PROVIDER',
    async verifyAndParse(){
      return {...event(),eventType:'ACCEPTED'};
    },
  });
  await assert.rejects(
    malformed.verify({headers:{},rawBody:Buffer.from('payload')}),
    error=>error instanceof EmailWebhookVerificationError &&
      error.code==='VERIFIED_WEBHOOK_EVENT_INVALID'
  );

  const mismatch=createEmailWebhookVerifier({
    providerKey:'TEST_SIGNED_PROVIDER',
    async verifyAndParse(){
      return {...event(),providerKey:'OTHER_PROVIDER'};
    },
  });
  await assert.rejects(
    mismatch.verify({headers:{},rawBody:Buffer.from('payload')}),
    error=>error instanceof EmailWebhookVerificationError &&
      error.code==='PROVIDER_KEY_MISMATCH' &&
      error.statusCode===409
  );
});

test('raw body and headers are bounded and normalized before provider verification',async()=>{
  const verifier=createEmailWebhookVerifier({
    providerKey:'TEST_SIGNED_PROVIDER',
    async verifyAndParse(){return event();},
  });

  await assert.rejects(
    verifier.verify({headers:{'x-test':'a\nspoof'},rawBody:Buffer.from('payload')}),
    error=>error instanceof EmailWebhookVerificationError &&
      error.code==='INVALID_WEBHOOK_HEADERS'
  );
  await assert.rejects(
    verifier.verify({headers:{},rawBody:Buffer.alloc(1_048_577)}),
    error=>error instanceof EmailWebhookVerificationError &&
      error.code==='INVALID_WEBHOOK_RAW_BODY'
  );
});
