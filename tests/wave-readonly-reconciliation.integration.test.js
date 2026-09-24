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
  createWaveReconciliationReadAdapter,
} = require('../src/wave-reconciliation-read-adapter');
const {
  createWaveTwoPhaseGuardedRunner,
  WaveTwoPhaseRunnerError,
} = require('../src/wave-two-phase-guarded-runner');
const {
  createWaveReadonlyReconciler,
} = require('../src/wave-readonly-reconciler');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const WAVE_BUSINESS = 'wave-business-reconcile-synthetic';
const WAVE_CUSTOMER = 'wave-customer-reconcile-synthetic';
const PRODUCT = 'wave-product-reconcile-synthetic';
const TOKEN = 'synthetic-reconcile-token-never-real-123456';

async function context(pool, businessId) {
  const password = 'fictional-reconciliation-password-2026!';
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
  const executionStore = createProviderExecutionStore({ pool, businessId });
  const createConfirmationStore = createWaveCreateConfirmationStore({ pool, businessId });
  const attemptStore = createWaveNetworkAttemptStore({ pool, businessId });
  const email = 'customer-' + crypto.randomUUID() + '@example.test';

  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic customer', email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Read-only reconciliation fixture',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'reconcile_' + crypto.randomBytes(12).toString('hex'));

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
    productIds: [PRODUCT],
    salesTaxes: {},
  });

  return {
    draft, authorization, mapping, mappings,
    executionStore, createConfirmationStore, attemptStore,
  };
}

function providerInvoice(status, invoiceId = 'wave-invoice-reconcile', number = 'SYNTHETIC-2001') {
  return {
    id: invoiceId,
    createdAt: '2026-09-23T20:00:00Z',
    modifiedAt: '2026-09-23T20:00:01Z',
    status,
    invoiceNumber: number,
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    customer: { id: WAVE_CUSTOMER },
    currency: { code: 'CAD' },
    taxTotal: { value: '0.00' },
    total: { value: '30.00' },
    items: [{
      product: { id: PRODUCT },
      description: 'Synthetic service',
      quantity: '2.00000000',
      unitPrice: '15.00000000',
      taxes: [],
    }],
  };
}

function createPayload(invoiceId = 'wave-invoice-reconcile') {
  const invoice = providerInvoice('DRAFT', invoiceId, 'SYNTHETIC-DRAFT-2001');
  return {
    data: {
      invoiceCreate: {
        didSucceed: true,
        inputErrors: [],
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          invoiceDate: invoice.invoiceDate,
          dueDate: invoice.dueDate,
          customer: invoice.customer,
          currency: invoice.currency,
          taxTotal: invoice.taxTotal,
          total: invoice.total,
        },
      },
    },
  };
}

function approvePayload(invoiceId = 'wave-invoice-reconcile') {
  const invoice = providerInvoice('SAVED', invoiceId, 'SYNTHETIC-2001');
  return {
    data: {
      invoiceApprove: {
        didSucceed: true,
        inputErrors: [],
        invoice: {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          customer: invoice.customer,
          currency: invoice.currency,
          taxTotal: invoice.taxTotal,
          total: invoice.total,
        },
      },
    },
  };
}

function mutationAdapter(fetchImpl) {
  return createWaveNetworkAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: WAVE_BUSINESS,
    grantedScopes: ['invoice:write'],
    fetchImpl,
  });
}

function readAdapter(fetchImpl) {
  return createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: WAVE_BUSINESS,
    grantedScopes: ['invoice:read'],
    fetchImpl,
  });
}

function runner(ctx, adapter) {
  return createWaveTwoPhaseGuardedRunner({
    mappingStore: ctx.mappings,
    executionStore: ctx.executionStore,
    createConfirmationStore: ctx.createConfirmationStore,
    attemptStore: ctx.attemptStore,
    networkAdapter: adapter,
  });
}

function reconciler(ctx, adapter) {
  return createWaveReadonlyReconciler({
    mappingStore: ctx.mappings,
    executionStore: ctx.executionStore,
    createConfirmationStore: ctx.createConfirmationStore,
    attemptStore: ctx.attemptStore,
    readAdapter: adapter,
  });
}

function byIdFetch(invoice) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.query, /FacturationsReconcileInvoiceById/);
    return new Response(JSON.stringify({
      data: { business: { id: WAVE_BUSINESS, invoice } },
    }), { status: 200 });
  };
}

function searchFetch(invoices, { totalCount = invoices.length, totalPages = invoices.length ? 1 : 0 } = {}) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.query, /FacturationsReconcileInvoiceSearch/);
    assert.equal(body.variables.page, 1);
    assert.equal(body.variables.pageSize, 20);
    return new Response(JSON.stringify({
      data: {
        business: {
          id: WAVE_BUSINESS,
          invoices: {
            pageInfo: { currentPage: 1, totalPages, totalCount },
            edges: invoices.map(invoice => ({ node: invoice })),
          },
        },
      },
    }), { status: 200 });
  };
}

test('read by persisted provider invoice confirms an ambiguous approval without mutation retry', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'reconcile-approve-saved-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    let createCalls = 0;
    let approveCalls = 0;
    const firstRunner = runner(ctx, mutationAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        createCalls++;
        return new Response(JSON.stringify(createPayload()), { status: 200 });
      }
      approveCalls++;
      const error = new Error('synthetic timeout after request');
      error.name = 'TimeoutError';
      throw error;
    }));

    const first = await firstRunner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(first.execution.state, 'AMBIGUOUS');
    assert.equal(createCalls, 1);
    assert.equal(approveCalls, 1);

    const result = await reconciler(ctx,
      readAdapter(byIdFetch(providerInvoice('SAVED')))).reconcile({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
      });
    assert.equal(result.status, 'APPROVAL_CONFIRMED_BY_READ');
    assert.equal(result.execution.state, 'CONFIRMED');
    assert.equal(result.execution.providerInvoiceId, 'wave-invoice-reconcile');
    assert.equal(result.execution.officialInvoiceNumber, 'SYNTHETIC-2001');
    assert.equal(result.networkMutationPerformed, false);
    assert.equal(createCalls, 1);
    assert.equal(approveCalls, 1);
  } finally {
    await pool.end();
  }
});

test('exact DRAFT read after ambiguous approve permits only approval retry on same provider invoice', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'reconcile-approve-draft-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    let createCalls = 0;
    let approveCalls = 0;
    const ambiguousRunner = runner(ctx, mutationAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        createCalls++;
        return new Response(JSON.stringify(createPayload()), { status: 200 });
      }
      approveCalls++;
      const error = new Error('synthetic network loss');
      error.name = 'TimeoutError';
      throw error;
    }));
    const first = await ambiguousRunner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(first.execution.state, 'AMBIGUOUS');

    const read = await reconciler(ctx,
      readAdapter(byIdFetch(providerInvoice('DRAFT', 'wave-invoice-reconcile',
        'SYNTHETIC-DRAFT-2001')))).reconcile({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
      });
    assert.equal(read.status, 'APPROVAL_NOT_OBSERVED_RETRYABLE');
    assert.equal(read.execution.state, 'FAILED_RETRYABLE');
    assert.equal(read.mutationRetryAllowed, true);

    const retryRunner = runner(ctx, mutationAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        createCalls++;
        throw new Error('CREATE must never repeat');
      }
      approveCalls++;
      return new Response(JSON.stringify(approvePayload()), { status: 200 });
    }));
    const retried = await retryRunner.execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(retried.execution.state, 'CONFIRMED');
    assert.equal(createCalls, 1, 'reconciliation keeps the original provider draft');
    assert.equal(approveCalls, 2, 'only approval is retried after exact DRAFT observation');
  } finally {
    await pool.end();
  }
});

test('crash after CREATE network start uses bounded search, persists found draft and never recreates it', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'reconcile-create-found-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    const prepared = await ctx.executionStore.prepare({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      provider: 'WAVE',
    });
    const started = await ctx.executionStore.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    });
    await ctx.attemptStore.start({
      executionId: started.id,
      executionVersion: started.version,
      operation: 'CREATE_DRAFT',
    });

    const result = await reconciler(ctx,
      readAdapter(searchFetch([
        providerInvoice('DRAFT', 'wave-invoice-found-after-crash', 'SYNTHETIC-DRAFT-3001'),
      ]))).reconcile({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
      });
    assert.equal(result.status, 'CREATE_FOUND_APPROVAL_PENDING');
    assert.equal(result.execution.state, 'FAILED_RETRYABLE');
    assert.equal(result.createConfirmation.providerInvoiceId, 'wave-invoice-found-after-crash');

    let createCalls = 0;
    let approveCalls = 0;
    const retried = await runner(ctx, mutationAdapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('invoiceCreate')) {
        createCalls++;
        throw new Error('CREATE must never repeat after bounded exact match');
      }
      approveCalls++;
      return new Response(JSON.stringify(
        approvePayload('wave-invoice-found-after-crash')), { status: 200 });
    })).execute({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
    });
    assert.equal(retried.execution.state, 'CONFIRMED');
    assert.equal(createCalls, 0);
    assert.equal(approveCalls, 1);
  } finally {
    await pool.end();
  }
});

test('empty bounded search remains ambiguous and does not unlock CREATE retry', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'reconcile-create-empty-' + crypto.randomUUID();
  try {
    const ctx = await context(pool, businessId);
    const prepared = await ctx.executionStore.prepare({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      provider: 'WAVE',
    });
    const started = await ctx.executionStore.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    });
    await ctx.attemptStore.start({
      executionId: started.id,
      executionVersion: started.version,
      operation: 'CREATE_DRAFT',
    });

    const result = await reconciler(ctx,
      readAdapter(searchFetch([], { totalCount: 0, totalPages: 0 }))).reconcile({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
      });
    assert.equal(result.status, 'RECONCILIATION_INCONCLUSIVE');
    assert.equal(result.reason, 'BOUNDED_SEARCH_NO_EXACT_MATCH');
    assert.equal(result.execution.state, 'AMBIGUOUS');
    assert.equal(result.mutationRetryAllowed, false);

    let mutations = 0;
    await assert.rejects(
      runner(ctx, mutationAdapter(async () => {
        mutations++;
        throw new Error('must never mutate while ambiguous');
      })).execute({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
      }),
      error => error instanceof WaveTwoPhaseRunnerError &&
        error.code === 'RECONCILIATION_REQUIRED' &&
        error.statusCode === 409
    );
    assert.equal(mutations, 0);
  } finally {
    await pool.end();
  }
});
