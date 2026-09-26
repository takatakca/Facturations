'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {createDraftApprovalStore}=require('../src/draft-approval-store');
const {createIssuanceAuthorizationStore}=require('../src/issuance-authorization-store');
const {createProviderIssuanceAttemptStore}=require('../src/provider-issuance-attempt-store');
const {createProviderIssuanceExecutor}=require('../src/provider-issuance-executor');
const {createIssuedInvoiceRegistry}=require('../src/issued-invoice-registry');
const {
  createPaymentEvidenceStore,
  PaymentEvidenceError,
}=require('../src/payment-evidence-store');
const {buildWaveIssuancePreflight}=require('../src/wave-issuance-preflight');

const DATABASE=process.env.FACTURATIONS_TEST_DATABASE_URL;

async function createIssuedInvoice({pool,businessId}){
  const password='synthetic-payment-password-2026!';
  const auth=createStaffAuthStore({pool,businessId});
  const invitations=createStaffInvitationStore({pool,businessId});
  const drafts=createDraftStore({pool,businessId});
  const approvals=createDraftApprovalStore({pool,businessId});
  const authorizations=createIssuanceAuthorizationStore({pool,businessId});
  const attempts=createProviderIssuanceAttemptStore({pool,businessId});
  const registry=createIssuedInvoiceRegistry({pool,businessId});

  const owner=await auth.createPendingStaff({
    email:'payment-owner-'+crypto.randomUUID()+'@example.test',
    password,
    role:'OWNER',
  });
  const invitation=await invitations.issueInvitation({staffId:owner.id});
  await invitations.redeemInvitation({token:invitation.token,password});
  const session=await auth.authenticate({email:owner.email,password});
  const customerEmail='payment-client-'+crypto.randomUUID()+'@example.test';

  const draft=await drafts.createDraft({
    currency:'CAD',
    customer:{name:'Synthetic Payment Customer',email:customerEmail,address:'123 Example Street'},
    invoiceDate:'2026-09-26',
    dueDate:'2026-10-26',
    notes:'Synthetic payment evidence fixture',
    lines:[{description:'Synthetic service',quantity:1,unitPriceCents:10000,discountCents:0,taxable:false}],
    taxes:[],
  },'payment_'+crypto.randomBytes(16).toString('hex'));

  await approvals.approveDraft({
    confirmation:'APPROVE_DRAFT_ONLY',
    draftId:draft.id,
    ownerId:owner.id,
    sessionToken:session.token,
    expectedTotalCents:10000,
    expectedCustomerEmail:customerEmail,
  });

  const authorization=await authorizations.authorize({
    confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId:draft.id,
    ownerId:owner.id,
    sessionToken:session.token,
    expectedTotalCents:10000,
    expectedCustomerEmail:customerEmail,
    provider:'WAVE',
  });

  const payload=buildWaveIssuancePreflight({
    businessId:'wave-business-payment',
    customerId:'wave-customer-payment',
    productIds:['wave-product-payment'],
    salesTaxes:{},
    snapshot:draft.preview,
  });
  const prepared=await attempts.prepare({authorizationId:authorization.id});
  const executor=createProviderIssuanceExecutor({
    attemptStore:attempts,
    adapter:{async createInvoice(){
      return {
        status:'CONFIRMED',
        providerInvoiceId:'wave-payment-'+crypto.randomUUID(),
        providerInvoiceNumber:'PAY-'+crypto.randomUUID().slice(0,8),
      };
    }},
  });
  const confirmed=await executor.execute({attemptId:prepared.id,payload});
  return registry.materialize({attemptId:confirmed.id});
}

test('payment evidence ledger is synthetic-only, idempotent, tenant-scoped and append-only',{
  skip:!DATABASE,
},async()=>{
  const url=new URL(DATABASE);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.pathname,'/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL,undefined);

  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='payment-ledger-'+crypto.randomUUID();
  try{
    const issued=await createIssuedInvoice({pool,businessId});
    const store=createPaymentEvidenceStore({
      pool,businessId,providerKey:'SYNTHETIC_PROCESSOR',
    });
    assert.equal(typeof store.ingestVerifiedWebhook,'undefined');

    const event={
      providerKey:'SYNTHETIC_PROCESSOR',
      eventId:'evt-'+crypto.randomUUID(),
      providerTransactionId:'txn-'+crypto.randomUUID(),
      eventType:'PAYMENT_RECEIVED',
      amountCents:4000,
      currency:'CAD',
      occurredAt:'2026-09-26T16:00:00.000Z',
    };
    const payment=await store.ingestSynthetic({issuedInvoiceId:issued.id,event});
    assert.equal(payment.issuedInvoiceId,issued.id);
    assert.equal(payment.eventType,'PAYMENT_RECEIVED');
    assert.equal(payment.amountCents,4000);
    assert.equal(payment.currency,'CAD');
    assert.equal(payment.sourceMode,'SYNTHETIC_TEST');
    assert.equal(payment.externallyVerified,false);
    assert.match(payment.evidenceHash,/^[a-f0-9]{64}$/);

    const retry=await store.ingestSynthetic({issuedInvoiceId:issued.id,event});
    assert.equal(retry.id,payment.id);
    assert.equal(retry.evidenceHash,payment.evidenceHash);

    await assert.rejects(
      store.ingestSynthetic({
        issuedInvoiceId:issued.id,
        event:{...event,amountCents:5000},
      }),
      error=>error instanceof PaymentEvidenceError &&
        error.code==='PAYMENT_EVIDENCE_EVENT_CONFLICT' &&
        error.statusCode===409
    );

    const refundEvent={
      providerKey:'SYNTHETIC_PROCESSOR',
      eventId:'evt-'+crypto.randomUUID(),
      providerTransactionId:'refund-'+crypto.randomUUID(),
      eventType:'REFUND_ISSUED',
      amountCents:1000,
      currency:'CAD',
      occurredAt:'2026-09-26T16:05:00.000Z',
    };
    const refund=await store.ingestSynthetic({issuedInvoiceId:issued.id,event:refundEvent});
    assert.equal(refund.eventType,'REFUND_ISSUED');

    const listed=await store.listByIssuedInvoice({issuedInvoiceId:issued.id});
    assert.equal(listed.length,2);
    assert.deepEqual(listed.map(item=>item.eventType),['PAYMENT_RECEIVED','REFUND_ISSUED']);

    const foreign=createPaymentEvidenceStore({
      pool,businessId:'payment-other-'+crypto.randomUUID(),providerKey:'SYNTHETIC_PROCESSOR',
    });
    assert.deepEqual(await foreign.listByIssuedInvoice({issuedInvoiceId:issued.id}),[]);

    await assert.rejects(
      pool.query(
        'UPDATE facturations_payment_evidence SET amount_cents=amount_cents WHERE business_id=$1 AND id=$2',
        [businessId,payment.id]
      ),
      error=>error && error.code==='23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_payment_evidence WHERE business_id=$1 AND id=$2',
        [businessId,payment.id]
      ),
      error=>error && error.code==='23514'
    );
  }finally{
    await pool.end();
  }
});
