'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createWaveMappingStore, WaveMappingError } = require('../src/wave-mapping-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function authorize(pool, businessId, { discountCents = 0 } = {}) {
  const password = 'fictional-wave-mapping-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invites = createStaffInvitationStore({ pool, businessId });
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test', password, role: 'OWNER',
  });
  const invitation = await invites.issueInvitation({ staffId: owner.id });
  await invites.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });

  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const email = 'customer-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic mapping customer', email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'No Wave network call',
    lines: [
      { description: 'Taxable service', quantity: 2, unitPriceCents: 1500,
        discountCents, taxable: true },
      { description: 'Non-taxable service', quantity: 1, unitPriceCents: 500,
        discountCents: 0, taxable: false },
    ],
    taxes: [
      { code: 'GST', label: 'Synthetic GST', rateMilliPercent: 5000 },
      { code: 'QST', label: 'Synthetic QST', rateMilliPercent: 9975 },
    ],
  }, 'mapping_' + crypto.randomBytes(12).toString('hex'));

  await approvals.approveDraft({
    confirmation: 'APPROVE_DRAFT_ONLY',
    draftId: draft.id, ownerId: owner.id, sessionToken: session.token,
    expectedTotalCents: draft.preview.totalCents, expectedCustomerEmail: email,
  });
  const authorization = await authorizations.authorize({
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId: draft.id, ownerId: owner.id, sessionToken: session.token,
    expectedTotalCents: draft.preview.totalCents, expectedCustomerEmail: email, provider: 'WAVE',
  });
  return { draft, authorization };
}

function mappingInput(authorization, draft) {
  return {
    authorizationId: authorization.id,
    draftId: draft.id,
    waveBusinessId: 'wave-business-synthetic',
    waveCustomerId: 'wave-customer-synthetic',
    productIds: ['wave-product-taxable', 'wave-product-nontaxable'],
    salesTaxes: {
      GST: { id: 'wave-tax-gst-synthetic', rateMilliPercent: 5000 },
      QST: { id: 'wave-tax-qst-synthetic', rateMilliPercent: 9975 },
    },
  };
}
function expectCode(code, statusCode = 422) {
  return error => error instanceof WaveMappingError &&
    error.code === code && error.statusCode === statusCode;
}

test('authorized immutable draft gets one exact persisted Wave mapping snapshot', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'wave-map-' + crypto.randomUUID();
  try {
    const { draft, authorization } = await authorize(pool, businessId);
    const store = createWaveMappingStore({ pool, businessId });
    const input = mappingInput(authorization, draft);

    const saved = await store.save(input);
    assert.equal(saved.authorizationId, authorization.id);
    assert.equal(saved.draftId, draft.id);
    assert.equal(saved.plan.status, 'READY_FOR_WAVE_ADAPTER');
    assert.equal(saved.plan.businessId, input.waveBusinessId);
    assert.equal(saved.plan.customerId, input.waveCustomerId);
    assert.deepEqual(saved.plan.items[0].salesTaxIds,
      ['wave-tax-gst-synthetic', 'wave-tax-qst-synthetic']);
    assert.deepEqual(saved.plan.items[1].salesTaxIds, []);
    assert.deepEqual(saved.plan.externalActionsPerformed, {
      createInvoice: false, approveInvoice: false, sendInvoice: false,
    });

    const repeated = await store.save(input);
    assert.equal(repeated.id, saved.id, 'same exact mapping is idempotent');

    const loaded = await store.getByAuthorization(authorization.id);
    assert.equal(loaded.id, saved.id);
    assert.deepEqual(loaded.plan, saved.plan);

    await assert.rejects(store.save({
      ...input,
      waveCustomerId: 'different-wave-customer',
    }), expectCode('MAPPING_CONFLICT', 409));
    await assert.rejects(store.save({
      ...input,
      productIds: ['different-wave-product', input.productIds[1]],
    }), expectCode('MAPPING_CONFLICT', 409));

    const [main, lines, taxes] = await Promise.all([
      pool.query('SELECT count(*)::integer AS n FROM facturations_wave_issuance_mappings WHERE business_id=$1',
        [businessId]),
      pool.query('SELECT line_index,wave_product_id FROM facturations_wave_line_mappings WHERE business_id=$1 ORDER BY line_index',
        [businessId]),
      pool.query('SELECT tax_code,wave_sales_tax_id,rate_milli_percent FROM facturations_wave_tax_mappings WHERE business_id=$1 ORDER BY tax_code',
        [businessId]),
    ]);
    assert.equal(main.rows[0].n, 1);
    assert.deepEqual(lines.rows.map(row => row.line_index), [0, 1]);
    assert.equal(taxes.rows.length, 2);
    assert.deepEqual(taxes.rows.map(row => row.tax_code), ['GST', 'QST']);
  } finally {
    await pool.end();
  }
});

test('mapping refuses unknown authorization, tax mismatch and unsupported line discount', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'wave-map-negative-' + crypto.randomUUID();
  try {
    const clean = await authorize(pool, businessId);
    const store = createWaveMappingStore({ pool, businessId });
    const input = mappingInput(clean.authorization, clean.draft);

    await assert.rejects(store.save({
      ...input,
      authorizationId: crypto.randomUUID(),
    }), expectCode('AUTHORIZATION_NOT_FOUND', 404));

    await assert.rejects(store.save({
      ...input,
      salesTaxes: {
        ...input.salesTaxes,
        QST: { id: 'wave-tax-qst-synthetic', rateMilliPercent: 9976 },
      },
    }), expectCode('WAVE_TAX_RATE_MISMATCH', 409));

    const discounted = await authorize(pool, businessId + '-discount', { discountCents: 100 });
    const discountStore = createWaveMappingStore({ pool, businessId: businessId + '-discount' });
    await assert.rejects(discountStore.save(mappingInput(discounted.authorization, discounted.draft)),
      expectCode('WAVE_LINE_DISCOUNT_UNSUPPORTED', 409));
  } finally {
    await pool.end();
  }
});
