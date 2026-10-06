'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');

const {
  StripeWebhookError,
  verifyStripeWebhook,
  stripeEventToPaymentEvidence,
  stripeEventToRefundEvidence,
} = require('../src/stripe-payment-webhook');
const { attachStripePaymentWebhook } = require('../src/stripe-payment-webhook-route');
const { loadConfig } = require('../src/config');

const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {createDraftApprovalStore}=require('../src/draft-approval-store');
const {createIssuanceAuthorizationStore}=require('../src/issuance-authorization-store');
const {createProviderIssuanceAttemptStore}=require('../src/provider-issuance-attempt-store');
const {createProviderIssuanceExecutor}=require('../src/provider-issuance-executor');
const {createIssuedInvoiceRegistry}=require('../src/issued-invoice-registry');
const {createPaymentEvidenceStore}=require('../src/payment-evidence-store');
const {createPaymentSummaryStore}=require('../src/payment-summary-store');
const {buildWaveIssuancePreflight}=require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const SECRET = 'whsec_' + 'test0nly'.repeat(5); // Fictional endpoint secret.
const BUSINESS = 'stripe-webhook-business';
const INVOICE = '22222222-2222-4222-8222-222222222222';

function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function sessionEvent(overrides = {}, session = {}) {
  return {
    id: 'evt_' + crypto.randomBytes(12).toString('hex'),
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: { object: {
      object: 'checkout.session', id: 'cs_test_123456', mode: 'payment', payment_status: 'paid',
      currency: 'cad', amount_total: 15522, payment_intent: 'pi_' + crypto.randomBytes(12).toString('hex'),
      metadata: { facturations_business_id: BUSINESS, facturations_issued_invoice_id: INVOICE },
      ...session,
    } },
    ...overrides,
  };
}

function refundEvent(refund = {}, overrides = {}) {
  return {
    id: 'evt_' + crypto.randomBytes(12).toString('hex'),
    object: 'event',
    type: 'refund.created',
    created: Math.floor(Date.now() / 1000),
    data: { object: { object: 'refund', id: 're_testrefund0001', amount: 5000, currency: 'cad', status: 'succeeded',
      payment_intent: 'pi_knownpayment01', created: 1790000000, ...refund } },
    ...overrides,
  };
}

test('refunds: succeeded Stripe refunds map to stable REFUND_ISSUED evidence', () => {
  const created = stripeEventToRefundEvidence(refundEvent());
  const updated = stripeEventToRefundEvidence(refundEvent({}, { type: 'refund.updated' }));
  assert.equal(created.relevant, true);
  assert.equal(created.paymentIntent, 'pi_knownpayment01');
  assert.deepEqual(created.event, {
    providerKey: 'STRIPE', eventId: 're_testrefund0001', providerTransactionId: 're_testrefund0001',
    relatedProviderTransactionId: 'pi_knownpayment01', eventType: 'REFUND_ISSUED', amountCents: 5000,
    currency: 'CAD', occurredAt: new Date(1790000000 * 1000).toISOString(),
  });
  assert.deepEqual(updated.event, created.event, 'refund.created and refund.updated are the same evidence');
  assert.equal(stripeEventToRefundEvidence(refundEvent({ status: 'pending' })).relevant, false);
  assert.equal(stripeEventToRefundEvidence(refundEvent({ status: 'failed' })).relevant, false);
  assert.equal(stripeEventToRefundEvidence(refundEvent({ payment_intent: null })).relevant, false);
  assert.equal(stripeEventToRefundEvidence(refundEvent({}, { type: 'charge.refunded' })).relevant, false);
  for (const refund of [{ currency: 'usd' }, { amount: 0 }, { id: 'nope' }, { created: null }]) {
    assert.throws(() => stripeEventToRefundEvidence(refundEvent(refund)), StripeWebhookError);
  }
});

test('Stripe signature verification is exact, time-bounded and constant-time', () => {
  const body = JSON.stringify(sessionEvent());
  const raw = Buffer.from(body);
  const ok = verifyStripeWebhook({ rawBody: raw, signatureHeader: sign(body), secret: SECRET });
  assert.equal(ok.verificationScheme, 'STRIPE_SIGNATURE_V1');
  assert.match(ok.rawBodySha256, /^[a-f0-9]{64}$/);
  assert.equal(ok.event.type, 'checkout.session.completed');

  const code = expected => error => error instanceof StripeWebhookError && error.code === expected;
  assert.throws(() => verifyStripeWebhook({ rawBody: raw, signatureHeader: sign(body, { secret: 'whsec_' + 'other000'.repeat(5) }), secret: SECRET }),
    code('STRIPE_SIGNATURE_VERIFICATION_FAILED'));
  assert.throws(() => verifyStripeWebhook({ rawBody: Buffer.from(body.replace('15522', '1')), signatureHeader: sign(body), secret: SECRET }),
    code('STRIPE_SIGNATURE_VERIFICATION_FAILED'));
  assert.throws(() => verifyStripeWebhook({ rawBody: raw, signatureHeader: sign(body, { timestamp: Math.floor(Date.now() / 1000) - 301 }), secret: SECRET }),
    code('STRIPE_SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE'));
  assert.throws(() => verifyStripeWebhook({ rawBody: raw, signatureHeader: sign(body, { timestamp: Math.floor(Date.now() / 1000) + 301 }), secret: SECRET }),
    code('STRIPE_SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE'));
  for (const header of [undefined, '', 'v1=abc', 't=123', 't=abc,v1=' + 'a'.repeat(64), 'garbage']) {
    assert.throws(() => verifyStripeWebhook({ rawBody: raw, signatureHeader: header, secret: SECRET }),
      code('INVALID_STRIPE_SIGNATURE_HEADER'));
  }
  const multi = `${sign(body)},v1=${'0'.repeat(64)}`;
  assert.ok(verifyStripeWebhook({ rawBody: raw, signatureHeader: multi, secret: SECRET }));
  assert.throws(() => verifyStripeWebhook({ rawBody: raw, signatureHeader: sign(body), secret: 'not-a-secret' }),
    code('STRIPE_WEBHOOK_NOT_CONFIGURED'));
  const notJson = 'not json';
  assert.throws(() => verifyStripeWebhook({ rawBody: Buffer.from(notJson), signatureHeader: sign(notJson), secret: SECRET }),
    code('INVALID_WEBHOOK_JSON'));
});

test('only paid Checkout Sessions for this business and an exact invoice become evidence', () => {
  const mapped = stripeEventToPaymentEvidence(sessionEvent(), { businessId: BUSINESS });
  assert.equal(mapped.relevant, true);
  assert.equal(mapped.issuedInvoiceId, INVOICE);
  assert.equal(mapped.event.providerKey, 'STRIPE');
  assert.equal(mapped.event.eventType, 'PAYMENT_RECEIVED');
  assert.equal(mapped.event.amountCents, 15522);
  assert.equal(mapped.event.currency, 'CAD');
  assert.match(mapped.event.providerTransactionId, /^pi_/);

  assert.equal(stripeEventToPaymentEvidence(sessionEvent({ type: 'invoice.paid' }), { businessId: BUSINESS }).relevant, false);
  assert.equal(stripeEventToPaymentEvidence(sessionEvent({}, { payment_status: 'unpaid' }), { businessId: BUSINESS }).relevant, false);
  assert.equal(stripeEventToPaymentEvidence(sessionEvent({}, { metadata: { facturations_business_id: 'other', facturations_issued_invoice_id: INVOICE } }), { businessId: BUSINESS }).reason, 'OTHER_BUSINESS');
  assert.equal(stripeEventToPaymentEvidence(sessionEvent({}, { metadata: {} }), { businessId: BUSINESS }).relevant, false);
  assert.equal(stripeEventToPaymentEvidence(sessionEvent({ type: 'checkout.session.async_payment_succeeded' }), { businessId: BUSINESS }).relevant, true);
  for (const session of [
    { currency: 'usd' }, { amount_total: 0 }, { payment_intent: null },
    { metadata: { facturations_business_id: BUSINESS, facturations_issued_invoice_id: 'nope' } },
  ]) {
    assert.throws(() => stripeEventToPaymentEvidence(sessionEvent({}, session), { businessId: BUSINESS }), StripeWebhookError);
  }
});

test('config: Stripe webhook secret must be a whsec_ secret with a dedicated database', () => {
  const base = { NODE_ENV: 'development', FACTURATIONS_DATABASE_URL: 'postgresql://x@127.0.0.1/facturations_test', WAVE_BUSINESS_ID: 'b' };
  assert.equal(loadConfig({ ...base, FACTURATIONS_STRIPE_WEBHOOK_SECRET: SECRET }).stripeWebhookSecret, SECRET);
  assert.equal(loadConfig(base).stripeWebhookSecret, '');
  assert.throws(() => loadConfig({ ...base, FACTURATIONS_STRIPE_WEBHOOK_SECRET: 'sk_live_wrong' }), /whsec_/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', FACTURATIONS_STRIPE_WEBHOOK_SECRET: SECRET }), /dedicated database/);
});

async function withWebhookServer(evidenceStore, run) {
  const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  attachStripePaymentWebhook(server, { secret: SECRET, businessId: BUSINESS, evidenceStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run('http://127.0.0.1:' + server.address().port + '/webhooks/stripe/payments');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('webhook route: verifies before parsing, records relevant events, never echoes provider data', async () => {
  const calls = [];
  const store = { providerKey: 'STRIPE', async findIssuedInvoiceByPaymentTransaction(pi) { return pi === 'pi_knownpayment01' ? INVOICE : null; }, async ingestVerifiedStripe(input) { calls.push(input); return { id: 'x' }; } };
  await withWebhookServer(store, async (url) => {
    const event = sessionEvent();
    const body = JSON.stringify(event);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'Stripe-Signature': sign(body), 'Content-Type': 'application/json' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: true, recorded: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].issuedInvoiceId, INVOICE);
    assert.equal(calls[0].verificationScheme, 'STRIPE_SIGNATURE_V1');
    assert.equal(calls[0].rawBodySha256, crypto.createHash('sha256').update(body).digest('hex'));

    const forged = await fetch(url, { method: 'POST', body, headers: { 'Stripe-Signature': sign(body, { secret: 'whsec_' + 'forged00'.repeat(5) }) } });
    assert.equal(forged.status, 400);
    assert.deepEqual(await forged.json(), { error: 'STRIPE_SIGNATURE_VERIFICATION_FAILED' });
    assert.equal((await fetch(url, { method: 'POST', body })).status, 400);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url + '?x=1', { method: 'POST', body, headers: { 'Stripe-Signature': sign(body) } })).status, 422);

    const refundBody = JSON.stringify(refundEvent());
    const refunded = await fetch(url, { method: 'POST', body: refundBody, headers: { 'Stripe-Signature': sign(refundBody) } });
    assert.deepEqual(await refunded.json(), { received: true, recorded: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].issuedInvoiceId, INVOICE);
    assert.equal(calls[1].event.eventType, 'REFUND_ISSUED');
    const foreignBody = JSON.stringify(refundEvent({ payment_intent: 'pi_subscription01' }));
    const foreign = await fetch(url, { method: 'POST', body: foreignBody, headers: { 'Stripe-Signature': sign(foreignBody) } });
    assert.deepEqual(await foreign.json(), { received: true, recorded: false }, 'refund of a non-Facturations payment is ignored');
    assert.equal(calls.length, 2);
    calls.pop();

    const ignoredBody = JSON.stringify(sessionEvent({ type: 'customer.created' }));
    const ignored = await fetch(url, { method: 'POST', body: ignoredBody, headers: { 'Stripe-Signature': sign(ignoredBody) } });
    assert.deepEqual(await ignored.json(), { received: true, recorded: false });
    assert.equal(calls.length, 1);
  });

  const failing = { providerKey: 'STRIPE', async findIssuedInvoiceByPaymentTransaction() { return null; }, async ingestVerifiedStripe() { const e = new Error('ISSUED_INVOICE_NOT_FOUND'); e.name = 'PaymentEvidenceError'; e.code = 'ISSUED_INVOICE_NOT_FOUND'; e.statusCode = 404; throw e; } };
  await withWebhookServer(failing, async (url) => {
    const body = JSON.stringify(sessionEvent());
    const response = await fetch(url, { method: 'POST', body, headers: { 'Stripe-Signature': sign(body) } });
    assert.equal(response.status, 404);
  });
  const broken = { providerKey: 'STRIPE', async findIssuedInvoiceByPaymentTransaction() { return null; }, async ingestVerifiedStripe() { throw new Error('db host detail'); } };
  await withWebhookServer(broken, async (url) => {
    const body = JSON.stringify(sessionEvent());
    const response = await fetch(url, { method: 'POST', body, headers: { 'Stripe-Signature': sign(body) } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
  });
  assert.throws(() => attachStripePaymentWebhook(http.createServer(() => {}), {
    secret: SECRET, businessId: BUSINESS, evidenceStore: { providerKey: 'SYNTHETIC_PROCESSOR', async findIssuedInvoiceByPaymentTransaction() { return null; }, async ingestVerifiedStripe() {} },
  }), TypeError);
});

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
  const prepared=await attempts.prepare({
    authorizationId:authorization.id,
    providerPlanHash:payload.providerPlanHash,
  });
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


test('disposable PostgreSQL: Stripe-signed payment becomes VERIFIED evidence end-to-end', { skip: !DATABASE }, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'stripe-verified-' + crypto.randomUUID();
  try {
    const issued = await createIssuedInvoice({ pool, businessId });
    const stripeStore = createPaymentEvidenceStore({ pool, businessId, providerKey: 'STRIPE' });
    const summaries = createPaymentSummaryStore({ pool, businessId });
    const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
    attachStripePaymentWebhook(server, { secret: SECRET, businessId, evidenceStore: stripeStore });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/webhooks/stripe/payments';
    const post = (body) => fetch(endpoint, { method: 'POST', body, headers: { 'Stripe-Signature': sign(body) } });
    try {
      const paymentIntent = 'pi_' + crypto.randomBytes(12).toString('hex');
      const event = sessionEvent({}, { amount_total: 10000, payment_intent: paymentIntent,
        metadata: { facturations_business_id: businessId, facturations_issued_invoice_id: issued.id } });
      const body = JSON.stringify(event);
      assert.equal((await post(body)).status, 200);
      const summary = await summaries.getByIssuedInvoice({ issuedInvoiceId: issued.id });
      assert.equal(summary.financialState, 'PAID');
      assert.equal(summary.proofScope, 'VERIFIED_PROVIDER_PRESENT');
      assert.equal(summary.externallyVerified, true);
      assert.equal(summary.balanceCents, 0);

      // Stripe retries the same event: idempotent, still one payment.
      assert.equal((await post(body)).status, 200);
      assert.equal((await summaries.getByIssuedInvoice({ issuedInvoiceId: issued.id })).paidCents, 10000);

      // A different event reusing the same PaymentIntent is refused.
      const reuse = JSON.stringify(sessionEvent({}, { amount_total: 10000, payment_intent: paymentIntent,
        metadata: { facturations_business_id: businessId, facturations_issued_invoice_id: issued.id } }));
      assert.equal((await post(reuse)).status, 409);

      // Unknown invoice -> 404 so Stripe retries and an operator notices.
      const missing = JSON.stringify(sessionEvent({}, {
        metadata: { facturations_business_id: businessId, facturations_issued_invoice_id: crypto.randomUUID() } }));
      assert.equal((await post(missing)).status, 404);

      // Refunds: partial, replay via refund.updated, full, then foreign PI ignored.
      const partialRefund = JSON.stringify(refundEvent({ id: 're_partial000001', amount: 4000, payment_intent: paymentIntent }));
      assert.equal((await post(partialRefund)).status, 200);
      let afterRefund = await summaries.getByIssuedInvoice({ issuedInvoiceId: issued.id });
      assert.equal(afterRefund.refundedCents, 4000);
      assert.equal(afterRefund.balanceCents, 4000);
      assert.notEqual(afterRefund.financialState, 'PAID');
      assert.equal((await post(JSON.stringify(refundEvent({ id: 're_partial000001', amount: 4000, payment_intent: paymentIntent }, { type: 'refund.updated' })))).status, 200);
      assert.equal((await summaries.getByIssuedInvoice({ issuedInvoiceId: issued.id })).refundedCents, 4000, 'refund.updated is idempotent');
      assert.equal((await post(JSON.stringify(refundEvent({ id: 're_rest00000001', amount: 6000, payment_intent: paymentIntent })))).status, 200);
      afterRefund = await summaries.getByIssuedInvoice({ issuedInvoiceId: issued.id });
      assert.equal(afterRefund.financialState, 'FULLY_REFUNDED');
      assert.equal(afterRefund.proofScope, 'VERIFIED_PROVIDER_PRESENT');
      const foreignRefund = await post(JSON.stringify(refundEvent({ id: 're_foreign00001', payment_intent: 'pi_notfacturations1' })));
      assert.equal(foreignRefund.status, 200);
      assert.deepEqual(await foreignRefund.json(), { received: true, recorded: false });

      const stored = await pool.query(
        `SELECT source_mode, provider_key, verification_scheme, webhook_body_sha256
           FROM facturations_payment_evidence WHERE business_id=$1`, [businessId]);
      assert.deepEqual(stored.rows.map(r => [r.source_mode, r.provider_key, r.verification_scheme]),
        Array(3).fill(['VERIFIED_PROVIDER_WEBHOOK', 'STRIPE', 'STRIPE_SIGNATURE_V1']));
      assert.ok(stored.rows.some(r => r.webhook_body_sha256 === crypto.createHash('sha256').update(body).digest('hex')));

      // Database refuses verified rows without Stripe provenance and synthetic rows with provenance.
      await assert.rejects(pool.query(
        `UPDATE facturations_payment_evidence SET verification_scheme='X' WHERE business_id=$1`, [businessId]));
      const syntheticStore = createPaymentEvidenceStore({ pool, businessId, providerKey: 'SYNTHETIC_PROCESSOR' });
      await assert.rejects(syntheticStore.ingestVerifiedStripe({ issuedInvoiceId: issued.id, event: {}, rawBodySha256: 'a'.repeat(64), verificationScheme: 'STRIPE_SIGNATURE_V1' }),
        error => error.code === 'PAYMENT_PROVIDER_KEY_MISMATCH');
      await assert.rejects(pool.query(
        `INSERT INTO facturations_payment_evidence (business_id,issued_invoice_id,provider_key,provider_event_id,provider_transaction_id,event_type,amount_cents,currency,occurred_at,source_mode,evidence_hash,webhook_body_sha256,verification_scheme)
         VALUES ($1,$2,'SYNTHETIC_PROCESSOR','evt-x','txn-x','PAYMENT_RECEIVED',1,'CAD',now(),'VERIFIED_PROVIDER_WEBHOOK',$3,$3,'STRIPE_SIGNATURE_V1')`,
        [businessId, issued.id, 'b'.repeat(64)]), error => error.code === '23514');
      await assert.rejects(pool.query(
        `INSERT INTO facturations_payment_evidence (business_id,issued_invoice_id,provider_key,provider_event_id,provider_transaction_id,event_type,amount_cents,currency,occurred_at,source_mode,evidence_hash,webhook_body_sha256,verification_scheme)
         VALUES ($1,$2,'SYNTHETIC_PROCESSOR','evt-y','txn-y','PAYMENT_RECEIVED',1,'CAD',now(),'SYNTHETIC_TEST',$3,$3,'STRIPE_SIGNATURE_V1')`,
        [businessId, issued.id, 'c'.repeat(64)]), error => error.code === '23514');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await pool.end();
  }
});
