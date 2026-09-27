'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const {
  createProviderIssuanceAttemptStore,
  ProviderIssuanceAttemptError,
} = require('../src/provider-issuance-attempt-store');
const {
  createProviderIssuanceExecutor,
  ProviderIssuanceExecutorError,
} = require('../src/provider-issuance-executor');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provisionOwner({ auth, invitations, password }) {
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invitations.issueInvitation({ staffId: owner.id });
  await invitations.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

async function authorizedDraft({ drafts, approvals, authorizations, owner, session, suffix }) {
  const email = 'customer-' + suffix + '-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic ' + suffix, email, address: 'Example only' },
    invoiceDate: '2026-09-25',
    dueDate: '2026-10-25',
    notes: 'Provider execution test only',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'provider_' + crypto.randomBytes(16).toString('hex'));

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

  const payload = buildWaveIssuancePreflight({
    businessId: 'wave-business-example',
    customerId: 'wave-customer-' + suffix,
    productIds: ['wave-product-' + suffix],
    salesTaxes: {},
    snapshot: draft.preview,
  });
  return { draft, authorization, payload };
}

test('persistent provider engine confirms, blocks ambiguous retry, and reconciles without any real Wave call', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'provider-engine-' + crypto.randomUUID();
  const password = 'synthetic-provider-engine-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invitations, password });

    const confirmedFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'confirmed',
    });
    const prepared = await attempts.prepare({
      authorizationId: confirmedFixture.authorization.id,
    });
    assert.equal(prepared.state, 'PREPARED');
    assert.match(prepared.operationKey, /^wave_[A-Za-z0-9_-]{43}$/);
    assert.equal(prepared.issued, false);
    assert.equal(prepared.waveSynced, false);
    assert.equal(prepared.emailed, false);

    const preparedRetry = await attempts.prepare({
      authorizationId: confirmedFixture.authorization.id,
    });
    assert.equal(preparedRetry.id, prepared.id);
    assert.equal(preparedRetry.operationKey, prepared.operationKey);

    const adapterCalls = [];
    const confirmedExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice(request) {
          adapterCalls.push(request);
          return {
            status: 'CONFIRMED',
            providerInvoiceId: 'wave-invoice-example-confirmed',
            providerInvoiceNumber: 'SYNTHETIC-1001',
          };
        },
      },
    });
    const confirmed = await confirmedExecutor.execute({
      attemptId: prepared.id,
      payload: confirmedFixture.payload,
    });
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.equal(confirmed.providerInvoiceId, 'wave-invoice-example-confirmed');
    assert.equal(confirmed.providerInvoiceNumber, 'SYNTHETIC-1001');
    assert.equal(confirmed.issued, false, 'provider confirmation does not mutate official local issuance');
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].operationKey, prepared.operationKey);
    assert.equal(adapterCalls[0].payload.status, 'READY_FOR_WAVE_ADAPTER');

    await assert.rejects(confirmedExecutor.execute({
      attemptId: prepared.id,
      payload: confirmedFixture.payload,
    }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'INVALID_ATTEMPT_STATE' &&
      error.statusCode === 409);
    assert.equal(adapterCalls.length, 1, 'confirmed attempt cannot call adapter twice');

    const ambiguousFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'ambiguous',
    });
    const ambiguousPrepared = await attempts.prepare({
      authorizationId: ambiguousFixture.authorization.id,
    });
    let ambiguousCalls = 0;
    const ambiguousExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          ambiguousCalls++;
          throw new Error('synthetic transport uncertainty');
        },
      },
    });
    const ambiguous = await ambiguousExecutor.execute({
      attemptId: ambiguousPrepared.id,
      payload: ambiguousFixture.payload,
    });
    assert.equal(ambiguous.state, 'AMBIGUOUS');
    assert.equal(ambiguous.outcomeCode, 'ADAPTER_EXCEPTION');
    assert.equal(ambiguous.finishedAt, null);

    await assert.rejects(ambiguousExecutor.execute({
      attemptId: ambiguousPrepared.id,
      payload: ambiguousFixture.payload,
    }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'AMBIGUOUS_REQUIRES_RECONCILIATION' &&
      error.statusCode === 409);
    assert.equal(ambiguousCalls, 1, 'ambiguous state blocks an automatic provider retry');

    await assert.rejects(ambiguousExecutor.reconcile({
      attemptId: ambiguousPrepared.id,
      result: { status: 'AMBIGUOUS', reasonCode: 'STILL_UNKNOWN' },
    }), error =>
      error instanceof ProviderIssuanceExecutorError &&
      error.code === 'RECONCILIATION_INCONCLUSIVE' &&
      error.statusCode === 409);

    const reconciled = await ambiguousExecutor.reconcile({
      attemptId: ambiguousPrepared.id,
      result: {
        status: 'CONFIRMED',
        providerInvoiceId: 'wave-invoice-example-reconciled',
        providerInvoiceNumber: 'SYNTHETIC-1002',
      },
    });
    assert.equal(reconciled.state, 'CONFIRMED');
    assert.equal(reconciled.outcomeCode, 'RECONCILED_CONFIRMED');

    const failedFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'failed',
    });
    const failedPrepared = await attempts.prepare({
      authorizationId: failedFixture.authorization.id,
    });
    const failedExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          return { status: 'FAILED', reasonCode: 'PROVIDER_REJECTED_SYNTHETIC' };
        },
      },
    });
    const failed = await failedExecutor.execute({
      attemptId: failedPrepared.id,
      payload: failedFixture.payload,
    });
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.outcomeCode, 'PROVIDER_REJECTED_SYNTHETIC');

    const foreign = createProviderIssuanceAttemptStore({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(foreign.get({ attemptId: prepared.id }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'ATTEMPT_NOT_FOUND' &&
      error.statusCode === 404);

    const [draftRows, authorizationRows, attemptRows, eventRows, auditRows] = await Promise.all([
      pool.query('SELECT id,status FROM invoice_drafts WHERE business_id=$1 ORDER BY id', [businessId]),
      pool.query(`SELECT id,state FROM facturations_issuance_authorizations
                    WHERE business_id=$1 ORDER BY id`, [businessId]),
      pool.query(`SELECT state,count(*)::integer AS n
                    FROM facturations_provider_issuance_attempts
                   WHERE business_id=$1 GROUP BY state ORDER BY state`, [businessId]),
      pool.query(`SELECT to_state,count(*)::integer AS n
                    FROM facturations_provider_issuance_events
                   WHERE business_id=$1 GROUP BY to_state ORDER BY to_state`, [businessId]),
      pool.query(`SELECT action,count(*)::integer AS n
                    FROM invoice_audit_events
                   WHERE business_id=$1 GROUP BY action ORDER BY action`, [businessId]),
    ]);

    assert.equal(draftRows.rows.length, 3);
    assert.ok(draftRows.rows.every(row => row.status === 'DRAFT'));
    assert.equal(authorizationRows.rows.length, 3);
    assert.ok(authorizationRows.rows.every(row => row.state === 'AUTHORIZED_PENDING_PROVIDER'));
    assert.deepEqual(attemptRows.rows, [
      { state: 'CONFIRMED', n: 2 },
      { state: 'FAILED', n: 1 },
    ]);
    assert.deepEqual(eventRows.rows, [
      { to_state: 'AMBIGUOUS', n: 1 },
      { to_state: 'CONFIRMED', n: 2 },
      { to_state: 'FAILED', n: 1 },
      { to_state: 'IN_PROGRESS', n: 3 },
      { to_state: 'PREPARED', n: 3 },
    ]);
    assert.deepEqual(auditRows.rows, [{ action: 'DRAFT_CREATED', n: 3 }]);
  } finally {
    await pool.end();
  }
});
