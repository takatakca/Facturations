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
  createProviderExecutionStore,
  ProviderExecutionError,
} = require('../src/provider-execution-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function ownerContext(pool, businessId) {
  const password = 'fictional-provider-execution-password-2026!';
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
  return { auth, owner, session };
}

async function authorizedDraft(pool, businessId) {
  const { owner, session } = await ownerContext(pool, businessId);
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const email = 'customer-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic customer', email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Provider state-machine test only',
    lines: [{ description: 'Synthetic service', quantity: 2, unitPriceCents: 1500, taxable: false }],
    taxes: [],
  }, 'provider_' + crypto.randomBytes(12).toString('hex'));
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
  return { draft, authorization };
}

function expectCode(code, statusCode = 409) {
  return error => error instanceof ProviderExecutionError &&
    error.code === code && error.statusCode === statusCode;
}

test('provider execution persists one stable operation and blocks retry after ambiguous outcome until reconciliation', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'provider-state-' + crypto.randomUUID();
  try {
    const { draft, authorization } = await authorizedDraft(pool, businessId);
    const executions = createProviderExecutionStore({ pool, businessId });

    const prepared = await executions.prepare({
      authorizationId: authorization.id,
      draftId: draft.id,
      provider: 'WAVE',
    });
    assert.equal(prepared.state, 'PREPARED');
    assert.equal(prepared.version, 1);
    assert.match(prepared.operationKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(prepared.providerInvoiceId, null);

    const duplicate = await executions.prepare({
      authorizationId: authorization.id,
      draftId: draft.id,
      provider: 'WAVE',
    });
    assert.equal(duplicate.id, prepared.id);
    assert.equal(duplicate.operationKey, prepared.operationKey,
      'repeated prepare keeps the original operation key');

    const started = await executions.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    });
    assert.equal(started.state, 'IN_PROGRESS');
    assert.equal(started.version, 2);
    assert.equal(started.operationKey, prepared.operationKey);

    await assert.rejects(executions.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    }), expectCode('VERSION_CONFLICT'));

    const ambiguous = await executions.recordOutcome({
      executionId: started.id,
      expectedVersion: started.version,
      outcome: 'AMBIGUOUS',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: 'SYNTHETIC_TIMEOUT',
    });
    assert.equal(ambiguous.state, 'AMBIGUOUS');
    assert.equal(ambiguous.version, 3);

    await assert.rejects(executions.begin({
      executionId: ambiguous.id,
      expectedVersion: ambiguous.version,
    }), expectCode('RECONCILIATION_REQUIRED'));

    const reconciled = await executions.reconcileAmbiguous({
      executionId: ambiguous.id,
      expectedVersion: ambiguous.version,
      resolution: 'NOT_FOUND_RETRYABLE',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: 'RECONCILED_NOT_FOUND',
    });
    assert.equal(reconciled.state, 'FAILED_RETRYABLE');
    assert.equal(reconciled.version, 4);
    assert.ok(reconciled.reconciledAt);

    const retryStarted = await executions.begin({
      executionId: reconciled.id,
      expectedVersion: reconciled.version,
    });
    assert.equal(retryStarted.state, 'IN_PROGRESS');
    assert.equal(retryStarted.operationKey, prepared.operationKey,
      'retry after reconciliation reuses the same local operation key');

    const confirmed = await executions.recordOutcome({
      executionId: retryStarted.id,
      expectedVersion: retryStarted.version,
      outcome: 'CONFIRMED',
      providerInvoiceId: 'synthetic-wave-invoice-id',
      officialInvoiceNumber: 'SYNTHETIC-0001',
      errorCode: null,
    });
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.equal(confirmed.providerInvoiceId, 'synthetic-wave-invoice-id');
    assert.equal(confirmed.officialInvoiceNumber, 'SYNTHETIC-0001');

    await assert.rejects(executions.begin({
      executionId: confirmed.id,
      expectedVersion: confirmed.version,
    }), expectCode('INVALID_STATE_TRANSITION'));
    await assert.rejects(executions.recordOutcome({
      executionId: confirmed.id,
      expectedVersion: confirmed.version,
      outcome: 'FAILED_FINAL',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: 'SHOULD_NOT_MUTATE',
    }), expectCode('INVALID_STATE_TRANSITION'));

    const rows = await pool.query(
      `SELECT state,version,operation_key,provider_invoice_id,official_invoice_number
         FROM facturations_provider_executions
        WHERE business_id=$1 AND authorization_id=$2`,
      [businessId, authorization.id]
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].state, 'CONFIRMED');
    assert.equal(rows.rows[0].operation_key, prepared.operationKey);

    const unchangedDraft = await pool.query(
      'SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [businessId, draft.id]
    );
    assert.equal(unchangedDraft.rows[0].status, 'DRAFT',
      'state-machine test never marks the local invoice as officially issued');
  } finally {
    await pool.end();
  }
});

test('provider execution refuses missing or mismatched authorization and invalid confirmed details', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'provider-negative-' + crypto.randomUUID();
  try {
    const { draft, authorization } = await authorizedDraft(pool, businessId);
    const executions = createProviderExecutionStore({ pool, businessId });

    await assert.rejects(executions.prepare({
      authorizationId: crypto.randomUUID(),
      draftId: draft.id,
      provider: 'WAVE',
    }), expectCode('AUTHORIZATION_NOT_FOUND', 404));

    await assert.rejects(executions.prepare({
      authorizationId: authorization.id,
      draftId: crypto.randomUUID(),
      provider: 'WAVE',
    }), expectCode('AUTHORIZATION_MISMATCH'));

    const prepared = await executions.prepare({
      authorizationId: authorization.id,
      draftId: draft.id,
      provider: 'WAVE',
    });
    const started = await executions.begin({
      executionId: prepared.id,
      expectedVersion: 1,
    });
    await assert.rejects(executions.recordOutcome({
      executionId: started.id,
      expectedVersion: started.version,
      outcome: 'CONFIRMED',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: null,
    }), expectCode('CONFIRMED_DETAILS_REQUIRED', 422));
  } finally {
    await pool.end();
  }
});
