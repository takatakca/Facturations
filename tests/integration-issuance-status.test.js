'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');

const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {createDraftApprovalStore}=require('../src/draft-approval-store');
const {createIssuanceAuthorizationStore}=require('../src/issuance-authorization-store');
const {createProviderIssuanceAttemptStore}=require('../src/provider-issuance-attempt-store');
const {createProviderIssuanceExecutor}=require('../src/provider-issuance-executor');
const {createIssuedInvoiceRegistry}=require('../src/issued-invoice-registry');
const {createPaymentEvidenceStore}=require('../src/payment-evidence-store');
const {buildWaveIssuancePreflight}=require('../src/wave-issuance-preflight');
const {
  createIntegrationIssuanceReadStore,
  IssuanceReadError,
} = require('../src/integration-issuance-read-store');

const SECRET = 'integration-test-secret-abcdefghijklmnopqrstuvwxyz012345';
const ISSUER = 'https://identity.takatak.ca';
const AUDIENCE = 'facturations';
const BUSINESS = 'business-one';
const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const DRAFT = '11111111-1111-4111-8111-111111111111';

function liveToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({
    version: 1, iss: ISSUER, aud: AUDIENCE, sub: 'master-user-123456', business_id: BUSINESS,
    roles: ['OWNER'], iat: now - 5, exp: now + 55, jti: 'issuance-' + crypto.randomUUID(), ...overrides,
  });
  return input + '.' + crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
}

const config = {
  businessId: BUSINESS, adminKey: '', waveToken: '', integrationEnabled: true,
  integrationWritesEnabled: false, integrationIssuer: ISSUER, integrationAudience: AUDIENCE,
  integrationSecret: SECRET,
};

async function withServer(options, run) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('integration issuance status: OWNER-only, read-only, bounded, fail-closed', async () => {
  const calls = [];
  const invoice = {
    id: '22222222-2222-4222-8222-222222222222', officialInvoiceNumber: 'INV-0001',
    issuedAt: '2026-10-06T12:00:00.000Z', currency: 'CAD', totalCents: '11498',
    balanceCents: '11498', financialState: 'NO_EVIDENCE', proofScope: 'NONE', provider: 'WAVE',
  };
  let current = null;
  const issuanceReadStore = { async getIssuanceByDraftId(id) { calls.push(id); return current; } };
  await withServer({ config, issuanceReadStore }, async (base) => {
    const get = (headers, suffix = '') => fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance' + suffix, { headers });

    const staff = await get({ Authorization: 'Bearer ' + liveToken({ roles: ['STAFF'] }) });
    assert.equal(staff.status, 403);
    assert.deepEqual(calls, []);
    assert.equal((await get({})).status, 401);
    assert.equal((await get({ Authorization: 'Bearer ' + liveToken() }, '?x=1')).status, 422);
    assert.equal((await fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance', {
      method: 'POST', headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 405);

    const notIssued = await get({ Authorization: 'Bearer ' + liveToken() });
    assert.equal(notIssued.status, 200);
    assert.deepEqual((await notIssued.json()).data, {
      draftId: DRAFT, issued: false, invoice: null,
      nativeActions: { issue: false, deliver: false, recordPayment: false },
    });

    current = invoice;
    const issued = await get({ Authorization: 'Bearer ' + liveToken() });
    const body = await issued.json();
    assert.equal(body.businessId, BUSINESS);
    assert.deepEqual(body.data.invoice, {
      id: invoice.id, officialInvoiceNumber: 'INV-0001', issuedAt: invoice.issuedAt, currency: 'CAD',
      totalCents: '11498', balanceCents: '11498', financialState: 'NO_EVIDENCE', proofScope: 'NONE',
    });
    assert.equal(body.data.invoice.provider, undefined);

    const caps = await (await fetch(base + '/integration/v1/capabilities', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).json();
    assert.equal(caps.data.capabilities.issuanceStatusRead, true);
    const staffCaps = await (await fetch(base + '/integration/v1/capabilities', {
      headers: { Authorization: 'Bearer ' + liveToken({ roles: ['STAFF'] }) },
    })).json();
    assert.equal(staffCaps.data.capabilities.issuanceStatusRead, false);
  });

  const failing = { async getIssuanceByDraftId() { throw new IssuanceReadError('NOT_FOUND', 404); } };
  await withServer({ config, issuanceReadStore: failing }, async (base) => {
    assert.equal((await fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 404);
  });
  const broken = { async getIssuanceByDraftId() { throw new Error('connection detail must not leak'); } };
  await withServer({ config, issuanceReadStore: broken }, async (base) => {
    const response = await fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
  });
  await withServer({ config }, async (base) => {
    assert.equal((await fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 503);
  });
  await withServer({ config: { ...config, integrationEnabled: false }, issuanceReadStore }, async (base) => {
    assert.equal((await fetch(base + '/integration/v1/drafts/' + DRAFT + '/issuance', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 404);
  });
});

test('issuance read store validates input before touching storage', async () => {
  const store = createIntegrationIssuanceReadStore({
    pool: { async query() { throw new Error('must not query'); } }, businessId: BUSINESS,
  });
  await assert.rejects(store.getIssuanceByDraftId('not-a-uuid'), error => error.code === 'INVALID_DRAFT_ID');
  assert.throws(() => createIntegrationIssuanceReadStore({ pool: {}, businessId: BUSINESS }), TypeError);
  assert.throws(() => createIntegrationIssuanceReadStore({ pool: { query() {} }, businessId: '' }), TypeError);
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


test('issuance read store on disposable PostgreSQL: issued status, payment projection, tenant scope', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issuance-read-' + crypto.randomUUID();
  try {
    const drafts = createDraftStore({ pool, businessId });
    const store = createIntegrationIssuanceReadStore({ pool, businessId });
    const lonely = await drafts.createDraft({
      currency: 'CAD', customer: { name: 'Not Issued', email: 'not-issued-' + crypto.randomUUID() + '@example.test', address: null },
      invoiceDate: '2026-10-06', dueDate: '2026-10-21', notes: null,
      lines: [{ description: 'Line', quantity: 1, unitPriceCents: 100, discountCents: 0, taxable: false }], taxes: [],
    }, 'issuance_' + crypto.randomBytes(16).toString('hex'));
    assert.equal(await store.getIssuanceByDraftId(lonely.id), null);
    await assert.rejects(store.getIssuanceByDraftId(crypto.randomUUID()), error => error.code === 'NOT_FOUND');

    const issued = await createIssuedInvoice({ pool, businessId });
    const before = await store.getIssuanceByDraftId(issued.draftId);
    assert.equal(before.id, issued.id);
    assert.equal(before.officialInvoiceNumber, issued.officialInvoiceNumber);
    assert.equal(before.totalCents, '10000');
    assert.equal(before.balanceCents, '10000');
    assert.equal(before.financialState, 'NO_EVIDENCE');
    assert.equal(before.proofScope, 'NONE');
    for (const key of Object.keys(before)) {
      assert.ok(!['customer', 'email', 'snapshot', 'requestHash'].includes(key));
    }

    const evidence = createPaymentEvidenceStore({ pool, businessId, providerKey: 'SYNTHETIC_PROCESSOR' });
    await evidence.ingestSynthetic({ issuedInvoiceId: issued.id, event: {
      providerKey: 'SYNTHETIC_PROCESSOR', eventId: 'evt-' + crypto.randomUUID(),
      providerTransactionId: 'txn-' + crypto.randomUUID(), eventType: 'PAYMENT_RECEIVED',
      amountCents: 4000, currency: 'CAD', occurredAt: '2026-10-06T12:00:00.000Z',
    } });
    const after = await store.getIssuanceByDraftId(issued.draftId);
    assert.equal(after.financialState, 'PARTIALLY_PAID');
    assert.equal(after.balanceCents, '6000');
    assert.equal(after.proofScope, 'SYNTHETIC_ONLY');

    const foreign = createIntegrationIssuanceReadStore({ pool, businessId: 'other-' + crypto.randomUUID() });
    await assert.rejects(foreign.getIssuanceByDraftId(issued.draftId), error => error.code === 'NOT_FOUND');
  } finally {
    await pool.end();
  }
});
