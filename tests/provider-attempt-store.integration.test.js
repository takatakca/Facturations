'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {createDraftApprovalStore}=require('../src/draft-approval-store');
const {createIssuanceAuthorizationStore}=require('../src/issuance-authorization-store');
const {createProviderAttemptStore,ProviderAttemptError}=require('../src/provider-attempt-store');

const DATABASE=process.env.FACTURATIONS_TEST_DATABASE_URL;

async function ownerFixture({pool,businessId,password}){
  const auth=createStaffAuthStore({pool,businessId});
  const invites=createStaffInvitationStore({pool,businessId});
  const owner=await auth.createPendingStaff({
    email:'owner-'+crypto.randomUUID()+'@example.test',password,role:'OWNER',
  });
  const invitation=await invites.issueInvitation({staffId:owner.id});
  await invites.redeemInvitation({token:invitation.token,password});
  const session=await auth.authenticate({email:owner.email,password});
  return {auth,owner,session};
}
async function authorizedDraft({pool,businessId,owner,session}){
  const drafts=createDraftStore({pool,businessId});
  const approvals=createDraftApprovalStore({pool,businessId});
  const authorizations=createIssuanceAuthorizationStore({pool,businessId});
  const email='customer-'+crypto.randomUUID()+'@example.test';
  const draft=await drafts.createDraft({
    currency:'CAD',
    customer:{name:'Synthetic Customer',email,address:'Example only'},
    invoiceDate:'2026-09-23',
    dueDate:'2026-10-23',
    notes:'Provider state machine synthetic test',
    lines:[{description:'Synthetic service',quantity:2,unitPriceCents:1500,taxable:false}],
    taxes:[],
  },'draft_'+crypto.randomBytes(12).toString('hex'));
  await approvals.approveDraft({
    confirmation:'APPROVE_DRAFT_ONLY',
    draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    expectedTotalCents:3000,expectedCustomerEmail:email,
  });
  const authorization=await authorizations.authorize({
    confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    expectedTotalCents:3000,expectedCustomerEmail:email,provider:'WAVE',
  });
  return {draft,authorization,email};
}
function expectError(work,code,statusCode){
  return assert.rejects(work,error=>error instanceof ProviderAttemptError &&
    error.code===code && (statusCode===undefined||error.statusCode===statusCode));
}

test('ambiguous provider result blocks retries until explicit NOT_FOUND reconciliation', {
  skip:!DATABASE,
}, async()=>{
  const url=new URL(DATABASE);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.pathname,'/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL,undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN,undefined);

  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='provider-attempt-'+crypto.randomUUID();
  const password='fictional-provider-attempt-password-2026!';
  try{
    const {owner,session}=await ownerFixture({pool,businessId,password});
    const {draft,authorization}=await authorizedDraft({pool,businessId,owner,session});
    const store=createProviderAttemptStore({pool,businessId});
    const planHash=crypto.createHash('sha256').update('synthetic-plan-v1').digest('hex');

    const first=await store.prepare({
      draftId:draft.id,idempotencyKey:'attempt_'+crypto.randomBytes(12).toString('hex'),planHash,
    });
    assert.equal(first.state,'PREPARED');
    assert.equal(first.attemptNo,1);
    assert.equal(first.parentAttemptId,null);
    assert.equal(first.authorizationId,authorization.id);

    const duplicate=await store.prepare({
      draftId:draft.id,idempotencyKey:first.idempotencyKey,planHash,
    });
    assert.equal(duplicate.id,first.id);
    assert.equal((await pool.query(
      'SELECT count(*)::integer AS n FROM facturations_provider_attempt_events WHERE business_id=$1 AND attempt_id=$2',
      [businessId,first.id])).rows[0].n,1,'idempotent prepare must not duplicate event');

    await expectError(store.prepare({
      draftId:draft.id,idempotencyKey:'other_'+crypto.randomBytes(12).toString('hex'),planHash,
    }),'ATTEMPT_ACTIVE',409);

    const started=await store.start({attemptId:first.id});
    assert.equal(started.state,'IN_FLIGHT');
    assert.equal((await store.start({attemptId:first.id})).state,'IN_FLIGHT');

    const ambiguous=await store.recordOutcome({
      attemptId:first.id,outcome:'AMBIGUOUS',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'WAVE_TIMEOUT',
    });
    assert.equal(ambiguous.state,'AMBIGUOUS');
    await expectError(store.prepare({
      draftId:draft.id,idempotencyKey:'retry_'+crypto.randomBytes(12).toString('hex'),planHash,
    }),'RECONCILIATION_REQUIRED',409);

    const reconciled=await store.reconcile({
      attemptId:first.id,result:'NOT_FOUND',
      providerInvoiceId:null,providerInvoiceNumber:null,
    });
    assert.equal(reconciled.state,'RECONCILED_NOT_FOUND');

    const second=await store.prepare({
      draftId:draft.id,idempotencyKey:'retry_'+crypto.randomBytes(12).toString('hex'),planHash,
    });
    assert.equal(second.state,'PREPARED');
    assert.equal(second.attemptNo,2);
    assert.equal(second.parentAttemptId,first.id);

    await store.start({attemptId:second.id});
    const confirmed=await store.recordOutcome({
      attemptId:second.id,outcome:'CONFIRMED',
      providerInvoiceId:'wave-invoice-synthetic-id',
      providerInvoiceNumber:'SYNTHETIC-1001',
      errorCode:null,
    });
    assert.equal(confirmed.state,'CONFIRMED');
    assert.equal(confirmed.providerInvoiceNumber,'SYNTHETIC-1001');
    const sameConfirmed=await store.recordOutcome({
      attemptId:second.id,outcome:'CONFIRMED',
      providerInvoiceId:'wave-invoice-synthetic-id',
      providerInvoiceNumber:'SYNTHETIC-1001',
      errorCode:null,
    });
    assert.equal(sameConfirmed.id,confirmed.id);

    await expectError(store.prepare({
      draftId:draft.id,idempotencyKey:'third_'+crypto.randomBytes(12).toString('hex'),planHash,
    }),'ALREADY_CONFIRMED',409);

    const [attempts,events,draftRow,authorizationRow]=await Promise.all([
      pool.query(
        'SELECT attempt_no,state,parent_attempt_id FROM facturations_provider_attempts WHERE business_id=$1 AND draft_id=$2 ORDER BY attempt_no',
        [businessId,draft.id]),
      pool.query(
        'SELECT event_code,from_state,to_state FROM facturations_provider_attempt_events WHERE business_id=$1 ORDER BY id',
        [businessId]),
      pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',[businessId,draft.id]),
      pool.query('SELECT state FROM facturations_issuance_authorizations WHERE business_id=$1 AND id=$2',
        [businessId,authorization.id]),
    ]);
    assert.deepEqual(attempts.rows.map(r=>r.state),['RECONCILED_NOT_FOUND','CONFIRMED']);
    assert.equal(attempts.rows[1].parent_attempt_id,first.id);
    assert.deepEqual(events.rows.map(r=>r.event_code),[
      'ATTEMPT_PREPARED','ATTEMPT_STARTED','PROVIDER_AMBIGUOUS',
      'RECONCILIATION_NOT_FOUND','ATTEMPT_PREPARED','ATTEMPT_STARTED','PROVIDER_CONFIRMED',
    ]);
    assert.equal(draftRow.rows[0].status,'DRAFT','provider bookkeeping cannot issue local draft');
    assert.equal(authorizationRow.rows[0].state,'AUTHORIZED_PENDING_PROVIDER');

    await assert.rejects(
      pool.query(`UPDATE facturations_provider_attempts SET state='PREPARED'
                   WHERE business_id=$1 AND id=$2`,[businessId,second.id]),
      error=>error.code==='23514',
      'database trigger rejects invalid state rewinds'
    );
    await assert.rejects(
      pool.query('DELETE FROM facturations_provider_attempt_events WHERE business_id=$1',[businessId]),
      error=>error.code==='23514',
      'attempt audit events are append-only'
    );
  }finally{
    await pool.end();
  }
});

test('retryable and final failures have distinct retry behavior', {skip:!DATABASE}, async()=>{
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='provider-failure-'+crypto.randomUUID();
  const password='fictional-provider-failure-password-2026!';
  try{
    const {owner,session}=await ownerFixture({pool,businessId,password});
    const {draft}=await authorizedDraft({pool,businessId,owner,session});
    const store=createProviderAttemptStore({pool,businessId});
    const planHash='a'.repeat(64);

    const first=await store.prepare({
      draftId:draft.id,idempotencyKey:'failure_'+crypto.randomBytes(12).toString('hex'),planHash,
    });
    await store.start({attemptId:first.id});
    const failed=await store.recordOutcome({
      attemptId:first.id,outcome:'FAILED_RETRYABLE',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'WAVE_RATE_LIMITED',
    });
    assert.equal(failed.state,'FAILED_RETRYABLE');

    const retry=await store.prepare({
      draftId:draft.id,idempotencyKey:'failure_retry_'+crypto.randomBytes(10).toString('hex'),planHash,
    });
    assert.equal(retry.attemptNo,2);
    await store.start({attemptId:retry.id});
    await store.recordOutcome({
      attemptId:retry.id,outcome:'FAILED_FINAL',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'WAVE_ACCESS_DENIED',
    });
    await expectError(store.prepare({
      draftId:draft.id,idempotencyKey:'failure_final_'+crypto.randomBytes(10).toString('hex'),planHash,
    }),'FINAL_FAILURE',409);
  }finally{
    await pool.end();
  }
});

test('provider outcomes reject invented ids and illegal transitions before any retry', {skip:!DATABASE}, async()=>{
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='provider-validation-'+crypto.randomUUID();
  const password='fictional-provider-validation-password-2026!';
  try{
    const {owner,session}=await ownerFixture({pool,businessId,password});
    const {draft}=await authorizedDraft({pool,businessId,owner,session});
    const store=createProviderAttemptStore({pool,businessId});
    const attempt=await store.prepare({
      draftId:draft.id,idempotencyKey:'validation_'+crypto.randomBytes(12).toString('hex'),
      planHash:'b'.repeat(64),
    });
    await expectError(store.recordOutcome({
      attemptId:attempt.id,outcome:'CONFIRMED',
      providerInvoiceId:'id',providerInvoiceNumber:'number',errorCode:null,
    }),'OUTCOME_NOT_ALLOWED',409);

    await store.start({attemptId:attempt.id});
    await expectError(store.recordOutcome({
      attemptId:attempt.id,outcome:'AMBIGUOUS',
      providerInvoiceId:'invented',providerInvoiceNumber:null,errorCode:'WAVE_TIMEOUT',
    }),'UNCONFIRMED_PROVIDER_ID_FORBIDDEN');
    await expectError(store.recordOutcome({
      attemptId:attempt.id,outcome:'FAILED_RETRYABLE',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'bad message',
    }),'ERROR_CODE_REQUIRED');

    await store.recordOutcome({
      attemptId:attempt.id,outcome:'AMBIGUOUS',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'WAVE_TIMEOUT',
    });
    await expectError(store.reconcile({
      attemptId:attempt.id,result:'NOT_FOUND',
      providerInvoiceId:'invented',providerInvoiceNumber:null,
    }),'RECONCILIATION_PROVIDER_ID_FORBIDDEN');
  }finally{
    await pool.end();
  }
});
