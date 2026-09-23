'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createProviderExecutionStore, ProviderExecutionError } = require('../src/provider-execution-store');
const { createWaveMappingStore } = require('../src/wave-mapping-store');
const {
  createWaveMappedSimulatedRunner,
  WaveMappedRunnerError,
} = require('../src/wave-mapped-simulated-runner');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function authorizedMappedDraft(pool, businessId) {
  const password = 'fictional-mapped-runner-password-2026!';
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
    customer: { name: 'Synthetic runner customer', email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Simulated provider runner only',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'mapped_runner_' + crypto.randomBytes(12).toString('hex'));

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
    waveBusinessId: 'wave-business-synthetic',
    waveCustomerId: 'wave-customer-synthetic',
    productIds: ['wave-product-synthetic'],
    salesTaxes: {},
  });
  return { draft, authorization, mapping, mappings };
}

function confirmed(plan, suffix = '1') {
  return {
    kind: 'CONFIRMED',
    providerInvoiceId: 'synthetic-wave-invoice-' + suffix,
    officialInvoiceNumber: 'SYNTHETIC-' + suffix.padStart(4, '0'),
    customerId: plan.customerId,
    currency: plan.currency,
    totalCents: plan.expected.totalCents,
    taxTotalCents: plan.expected.taxTotalCents,
  };
}
function expectProvider(code) {
  return error => error instanceof ProviderExecutionError &&
    error.code === code && error.statusCode === 409;
}

test('persisted mapping executes through simulated adapter and confirms without issuing local draft', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'mapped-runner-confirmed-' + crypto.randomUUID();
  try {
    const context = await authorizedMappedDraft(pool, businessId);
    const executions = createProviderExecutionStore({ pool, businessId });
    let issueCalls = 0;
    let seenOperationKey = null;
    const adapter = {
      mode: 'SIMULATED_ONLY',
      async issue({ operationKey, plan }) {
        issueCalls++;
        seenOperationKey = operationKey;
        assert.deepEqual(plan, context.mapping.plan);
        return confirmed(plan, '1');
      },
      async reconcile() {
        throw new Error('reconciliation should not run');
      },
    };
    const runner = createWaveMappedSimulatedRunner({
      mappingStore: context.mappings,
      executionStore: executions,
      adapter,
    });

    const result = await runner.execute({
      authorizationId: context.authorization.id,
      draftId: context.draft.id,
    });
    assert.equal(result.simulated, true);
    assert.equal(result.mappingId, context.mapping.id);
    assert.equal(result.execution.state, 'CONFIRMED');
    assert.equal(result.execution.providerInvoiceId, 'synthetic-wave-invoice-1');
    assert.equal(result.execution.officialInvoiceNumber, 'SYNTHETIC-0001');
    assert.equal(issueCalls, 1);
    assert.equal(seenOperationKey, result.execution.operationKey);

    const local = await pool.query(
      'SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [businessId, context.draft.id]
    );
    assert.equal(local.rows[0].status, 'DRAFT',
      'simulated confirmation never marks the local invoice officially issued');
  } finally {
    await pool.end();
  }
});

test('ambiguous simulated result blocks retry until explicit reconciliation and preserves operation key', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'mapped-runner-ambiguous-' + crypto.randomUUID();
  try {
    const context = await authorizedMappedDraft(pool, businessId);
    const executions = createProviderExecutionStore({ pool, businessId });
    let mode = 'THROW';
    let issueCalls = 0;
    let reconcileMode = 'UNKNOWN';
    const operationKeys = [];
    const adapter = {
      mode: 'SIMULATED_ONLY',
      async issue({ operationKey, plan }) {
        issueCalls++;
        operationKeys.push(operationKey);
        if (mode === 'THROW') {
          const error = new Error('synthetic timeout');
          error.code = 'SIMULATED_TIMEOUT';
          throw error;
        }
        return confirmed(plan, '2');
      },
      async reconcile({ operationKey, plan }) {
        assert.equal(operationKey, operationKeys[0]);
        if (reconcileMode === 'UNKNOWN') {
          return { kind: 'UNKNOWN', code: 'SIMULATED_LOOKUP_UNAVAILABLE' };
        }
        if (reconcileMode === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
        return {
          kind: 'FOUND',
          providerInvoiceId: 'synthetic-wave-invoice-reconciled',
          officialInvoiceNumber: 'SYNTHETIC-9999',
          customerId: plan.customerId,
          currency: plan.currency,
          totalCents: plan.expected.totalCents,
          taxTotalCents: plan.expected.taxTotalCents,
        };
      },
    };
    const runner = createWaveMappedSimulatedRunner({
      mappingStore: context.mappings,
      executionStore: executions,
      adapter,
    });

    const first = await runner.execute({
      authorizationId: context.authorization.id,
      draftId: context.draft.id,
    });
    assert.equal(first.execution.state, 'AMBIGUOUS');
    assert.equal(first.execution.errorCode, 'SIMULATED_TIMEOUT');
    assert.equal(issueCalls, 1);

    await assert.rejects(runner.execute({
      authorizationId: context.authorization.id,
      draftId: context.draft.id,
    }), expectProvider('RECONCILIATION_REQUIRED'));
    assert.equal(issueCalls, 1, 'no adapter retry while provider result is ambiguous');

    await assert.rejects(runner.reconcile({
      authorizationId: context.authorization.id,
      executionId: first.execution.id,
    }), error => error instanceof WaveMappedRunnerError &&
      error.code === 'SIMULATED_LOOKUP_UNAVAILABLE' && error.statusCode === 503);
    assert.equal((await executions.get(first.execution.id)).state, 'AMBIGUOUS',
      'unknown reconciliation leaves state ambiguous');

    reconcileMode = 'NOT_FOUND';
    const reconciled = await runner.reconcile({
      authorizationId: context.authorization.id,
      executionId: first.execution.id,
    });
    assert.equal(reconciled.execution.state, 'FAILED_RETRYABLE');

    mode = 'CONFIRMED';
    const retry = await runner.execute({
      authorizationId: context.authorization.id,
      draftId: context.draft.id,
    });
    assert.equal(retry.execution.state, 'CONFIRMED');
    assert.equal(issueCalls, 2);
    assert.equal(operationKeys.length, 2);
    assert.equal(operationKeys[0], operationKeys[1],
      'retry after reconciliation reuses the same persistent operation key');
  } finally {
    await pool.end();
  }
});

test('malformed or mismatched simulated confirmation becomes ambiguous rather than confirmed', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'mapped-runner-mismatch-' + crypto.randomUUID();
  try {
    const context = await authorizedMappedDraft(pool, businessId);
    const executions = createProviderExecutionStore({ pool, businessId });
    const adapter = {
      mode: 'SIMULATED_ONLY',
      async issue({ plan }) {
        return { ...confirmed(plan, '3'), totalCents: plan.expected.totalCents + 1 };
      },
      async reconcile() { return { kind: 'UNKNOWN', code: 'NOT_USED' }; },
    };
    const runner = createWaveMappedSimulatedRunner({
      mappingStore: context.mappings,
      executionStore: executions,
      adapter,
    });
    const result = await runner.execute({
      authorizationId: context.authorization.id,
      draftId: context.draft.id,
    });
    assert.equal(result.execution.state, 'AMBIGUOUS');
    assert.equal(result.execution.errorCode, 'SIMULATED_WAVE_RESULT_MISMATCH');
    assert.equal(result.execution.providerInvoiceId, null);
  } finally {
    await pool.end();
  }
});

test('runner refuses adapters that are not explicitly simulated', () => {
  assert.throws(() => createWaveMappedSimulatedRunner({
    mappingStore: { getByAuthorization() {} },
    executionStore: {
      prepare() {}, begin() {}, recordOutcome() {}, reconcileAmbiguous() {}, get() {},
    },
    adapter: { mode: 'REAL', issue() {}, reconcile() {} },
  }), /SIMULATED_ONLY/);
});
