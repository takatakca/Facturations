'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createWaveMappingStore } = require('../src/wave-mapping-store');
const { createProviderExecutionStore } = require('../src/provider-execution-store');
const { createWaveCreateConfirmationStore } = require('../src/wave-create-confirmation-store');
const { createWaveNetworkAttemptStore } = require('../src/wave-network-attempt-store');
const { createWaveNetworkAdapter } = require('../src/wave-network-adapter');
const {
  createWaveTwoPhaseGuardedRunner,
  WaveTwoPhaseRunnerError,
} = require('../src/wave-two-phase-guarded-runner');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const WAVE_BUSINESS = 'wave-business-synthetic';
const WAVE_CUSTOMER = 'wave-customer-synthetic';

async function context(pool, businessId) {
  const password = 'fictional-two-phase-runner-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invites = createStaffInvitationStore({ pool, businessId });
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invites.issueInvitation({ staffId: owner.id });
  await invites.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });

  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const mappings = createWaveMappingStore({ pool, businessId });
  const email = 'customer-' + crypto.randomUUID() + '@example.test';

  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic customer', email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Guarded two-phase runner test only',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'two_phase_' + crypto.randomBytes(12).toString('hex'));

  await approvals.approveDraft({
    confirmation: 'APPROVE_DRAFT_ONLY',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: email,
  });
  const authorization = await authorizations.authorize({
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: email,
    provider: 'WAVE',
  });
  const mapping = await mappings.save({
    authorizationId: authorization.id,
    draftId: draft.id,
    waveBusinessId: WAVE_BUSINESS,
    waveCustomerId: WAVE_CUSTOMER,
    productIds: ['wave-product-synthetic'],
    salesTaxes: {},
  });

  return { draft, authorization, mapping, mappings };
}

function waveCreatePayload(invoiceId = 'wave-invoice-synthetic') {
  return {
    data: {
      invoiceCreate: {
        didSucceed: true,
        inputErrors: [],
        invoice: {
          id: invoiceId,
          invoiceNumber: 'SYNTHETIC-DRAFT-1001',
          status: 'DRAFT',
          invoiceDate: '2026-09-23',
          dueDate: '2026-10-23',
          customer: { id: WAVE_CUSTOMER },
          currency: { code: 'CAD' },
          taxTotal: { value: '0.00' },
          total: { value: '30.00' },
        },
      },
    },
  };
}

function waveApprovePayload(invoiceId = 'wave-invoice-synthetic') {
  return {
    data: {
      invoiceApprove: {
        didSucceed: true,
        inputErrors: [],
        invoice: {
          id: invoiceId,
          invoiceNumber: 'SYNTHETIC-1001',
          status: 'SAVED',
          customer: { id: WAVE_CUSTOMER },
          currency: { code: 'CAD' },
          taxTotal: { value: '0.00' },
          total: { value: '30.00' },
        },
      },
    },
  };
}

function networkAdapter(fetchImpl) {
  return createWaveNetworkAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: 'synthetic-token-never-leaves-ci-123456',
    allowedBusinessId: WAVE_BUSINESS,
    grantedScopes: ['invoice:write'],
    fetchImpl,
  });
}

function stores(pool, businessId) {
  return {
    executionStore: createProviderExecutionStore({ pool, businessId }),
    createConfirmationStore: createWaveCreateConfirmationStore({ pool, businessId }),
    attemptStore: createWaveNetworkAttemptStore({ pool, businessId }),
  };
}

test('guarded runner persists create before separate approve and is idempotent after confirmation', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'two-phase-success-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    const s = stores(pool, businessId);
    const operations = [];
    const adapter = networkAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        operations.push('CREATE');
        return new Response(JSON.stringify(waveCreatePayload()), { status: 200 });
      }
      if (body.query.includes('invoiceApprove')) {
        operations.push('APPROVE');
        return new Response(JSON.stringify(waveApprovePayload()), { status: 200 });
      }
      throw new Error('unexpected GraphQL operation');
    });
    const runner = createWaveTwoPhaseGuardedRunner({
      mappingStore: ctx.mappings,
      ...s,
      networkAdapter: adapter,
    });

    const first = await runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(first.execution.state, 'CONFIRMED');
    assert.equal(first.execution.providerInvoiceId, 'wave-invoice-synthetic');
    assert.equal(first.execution.officialInvoiceNumber, 'SYNTHETIC-1001');
    assert.equal(first.createConfirmation.providerInvoiceId, 'wave-invoice-synthetic');
    assert.deepEqual(operations, ['CREATE', 'APPROVE']);

    const rows = await pool.query(
      `SELECT operation,execution_version
         FROM facturations_wave_network_attempts
        WHERE business_id=$1 AND execution_id=$2
        ORDER BY started_at,id`,
      [businessId, first.execution.id]
    );
    assert.deepEqual(rows.rows.map(row => row.operation), ['CREATE_DRAFT', 'APPROVE_INVOICE']);
    assert.equal(new Set(rows.rows.map(row => row.execution_version)).size, 1);

    const local = await pool.query(
      'SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [businessId, ctx.draft.id]
    );
    assert.equal(local.rows[0].status, 'DRAFT',
      'network runner still does not change the local invoice status');

    const second = await runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.execution.id, first.execution.id);
    assert.deepEqual(operations, ['CREATE', 'APPROVE'],
      'confirmed execution never performs network again');
  } finally {
    await pool.end();
  }
});

test('retry after safe approval rejection reuses the same provider draft and never creates twice', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'two-phase-retry-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    const s = stores(pool, businessId);
    let createCalls = 0;
    let approveCalls = 0;
    const adapter = networkAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        createCalls++;
        return new Response(JSON.stringify(waveCreatePayload('wave-invoice-retry')), { status: 200 });
      }
      approveCalls++;
      if (approveCalls === 1) return new Response('{}', { status: 429 });
      return new Response(JSON.stringify(waveApprovePayload('wave-invoice-retry')), { status: 200 });
    });
    const runner = createWaveTwoPhaseGuardedRunner({
      mappingStore: ctx.mappings,
      ...s,
      networkAdapter: adapter,
    });

    const first = await runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(first.execution.state, 'FAILED_RETRYABLE');
    assert.equal(createCalls, 1);
    assert.equal(approveCalls, 1);
    assert.equal(first.createConfirmation.providerInvoiceId, 'wave-invoice-retry');

    const second = await runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(second.execution.state, 'CONFIRMED');
    assert.equal(createCalls, 1, 'retry skips invoiceCreate after persisted create confirmation');
    assert.equal(approveCalls, 2);
    assert.equal(second.execution.providerInvoiceId, 'wave-invoice-retry');

    const attempts = await pool.query(
      `SELECT operation,execution_version
         FROM facturations_wave_network_attempts
        WHERE business_id=$1 AND execution_id=$2
        ORDER BY execution_version,started_at,id`,
      [businessId, second.execution.id]
    );
    assert.equal(attempts.rows.filter(row => row.operation === 'CREATE_DRAFT').length, 1);
    assert.equal(attempts.rows.filter(row => row.operation === 'APPROVE_INVOICE').length, 2);
  } finally {
    await pool.end();
  }
});

test('started network marker blocks duplicate mutation after a crash window', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'two-phase-crash-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    const s = stores(pool, businessId);
    let networkCalls = 0;
    const runner = createWaveTwoPhaseGuardedRunner({
      mappingStore: ctx.mappings,
      ...s,
      networkAdapter: networkAdapter(async () => {
        networkCalls++;
        throw new Error('must not be reached');
      }),
    });

    const prepared = await s.executionStore.prepare({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      provider: 'WAVE',
    });
    const started = await s.executionStore.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    });
    await s.attemptStore.start({
      executionId: started.id,
      executionVersion: started.version,
      operation: 'CREATE_DRAFT',
    });

    await assert.rejects(runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    }), error => error instanceof WaveTwoPhaseRunnerError &&
      error.code === 'RECONCILIATION_REQUIRED' && error.statusCode === 409);
    assert.equal(networkCalls, 0,
      'an unresolved create attempt is never repeated after restart');

    await s.createConfirmationStore.save({
      executionId: started.id,
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      providerInvoiceId: 'wave-invoice-crash-window',
      providerInvoiceNumber: 'SYNTHETIC-DRAFT-CRASH',
    });
    await s.attemptStore.start({
      executionId: started.id,
      executionVersion: started.version,
      operation: 'APPROVE_INVOICE',
    });

    await assert.rejects(runner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    }), error => error instanceof WaveTwoPhaseRunnerError &&
      error.code === 'RECONCILIATION_REQUIRED' && error.statusCode === 409);
    assert.equal(networkCalls, 0,
      'an unresolved approval attempt is never repeated after restart');

    await assert.rejects(
      pool.query(
        `UPDATE facturations_wave_network_attempts SET operation='CREATE_DRAFT'
          WHERE business_id=$1 AND execution_id=$2`,
        [businessId, started.id]
      ),
      error => error.code === '23514',
      'network attempt journal is append-only'
    );
  } finally {
    await pool.end();
  }
});
