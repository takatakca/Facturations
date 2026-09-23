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
  createProviderIssuanceStore,
  ProviderIssuanceError,
} = require('../src/provider-issuance-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provisionOwner({ auth, invites, password }) {
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invites.issueInvitation({ staffId: owner.id });
  await invites.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

async function authorizeDraft({
  drafts, approvals, authorizations, owner, session, suffix,
}) {
  const email = 'customer-' + suffix + '-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic ' + suffix, email, address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Provider-state integration test only',
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
  return { draft, authorization, email };
}

function attemptKey(label) {
  return label + '_' + crypto.randomBytes(12).toString('hex');
}

test('provider execution state blocks blind retries and requires reconciliation after ambiguity', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'provider-execution-' + crypto.randomUUID();
  const password = 'fictional-provider-state-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invites = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const provider = createProviderIssuanceStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invites, password });

    const ambiguousCase = await authorizeDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'ambiguous',
    });
    const loadedAuthorized = await provider.loadAuthorizedDraft({
      authorizationId: ambiguousCase.authorization.id,
    });
    assert.equal(loadedAuthorized.authorizationId, ambiguousCase.authorization.id);
    assert.equal(loadedAuthorized.draftId, ambiguousCase.draft.id);
    assert.equal(loadedAuthorized.provider, 'WAVE');
    assert.equal(loadedAuthorized.draft.status, 'DRAFT');
    assert.equal(loadedAuthorized.draft.preview.totalCents, 3000);
    assert.equal(loadedAuthorized.draft.preview.customer.email, ambiguousCase.email);

    const firstKey = attemptKey('first');
    const first = await provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: firstKey,
      provider: 'WAVE',
    });
    assert.equal(first.created, true);
    assert.equal(first.status, 'PROVIDER_ATTEMPT_STARTED');
    assert.equal(first.externalCallPerformed, false);
    assert.equal(first.issued, false);

    const repeatedStart = await provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: firstKey,
      provider: 'WAVE',
    });
    assert.equal(repeatedStart.id, first.id);
    assert.equal(repeatedStart.created, false);

    await assert.rejects(provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: attemptKey('concurrent'),
      provider: 'WAVE',
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'ATTEMPT_IN_FLIGHT' && error.statusCode === 409);

    const ambiguous = await provider.recordOutcome({
      attemptId: first.id,
      outcome: 'AMBIGUOUS',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    assert.equal(ambiguous.outcome, 'AMBIGUOUS');
    assert.equal(ambiguous.externalCallPerformedByStore, false);

    const sameAmbiguous = await provider.recordOutcome({
      attemptId: first.id,
      outcome: 'AMBIGUOUS',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    assert.equal(sameAmbiguous.id, ambiguous.id);

    await assert.rejects(provider.recordOutcome({
      attemptId: first.id,
      outcome: 'FAILED_RETRYABLE',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'OUTCOME_CONFLICT' && error.statusCode === 409);

    await assert.rejects(provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: attemptKey('blind-retry'),
      provider: 'WAVE',
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'RECONCILIATION_REQUIRED' && error.statusCode === 409);

    const notFound = await provider.recordReconciliation({
      attemptId: first.id,
      resolution: 'NOT_FOUND',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    assert.equal(notFound.resolution, 'NOT_FOUND');

    const retry = await provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: attemptKey('safe-retry'),
      provider: 'WAVE',
    });
    assert.equal(retry.created, true);
    assert.notEqual(retry.id, first.id);

    const confirmed = await provider.recordOutcome({
      attemptId: retry.id,
      outcome: 'CONFIRMED',
      providerInvoiceId: 'wave-invoice-example-' + crypto.randomUUID(),
      providerInvoiceNumber: 'EXAMPLE-1001',
    });
    assert.equal(confirmed.outcome, 'CONFIRMED');
    assert.equal(confirmed.providerInvoiceNumber, 'EXAMPLE-1001');

    await assert.rejects(provider.beginAttempt({
      authorizationId: ambiguousCase.authorization.id,
      attemptKey: attemptKey('after-confirmed'),
      provider: 'WAVE',
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'ALREADY_CONFIRMED' && error.statusCode === 409);

    const state = await provider.getExecutionState({
      authorizationId: ambiguousCase.authorization.id,
    });
    assert.equal(state.attempts.length, 2);
    assert.equal(state.attempts[0].outcome, 'AMBIGUOUS');
    assert.equal(state.attempts[0].reconciliation, 'NOT_FOUND');
    assert.equal(state.attempts[1].outcome, 'CONFIRMED');

    const existingCase = await authorizeDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'existing',
    });
    const existingAttempt = await provider.beginAttempt({
      authorizationId: existingCase.authorization.id,
      attemptKey: attemptKey('existing'),
      provider: 'WAVE',
    });
    await provider.recordOutcome({
      attemptId: existingAttempt.id,
      outcome: 'AMBIGUOUS',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    const reconciliation = await provider.recordReconciliation({
      attemptId: existingAttempt.id,
      resolution: 'CONFIRMED_EXISTING',
      providerInvoiceId: 'wave-existing-' + crypto.randomUUID(),
      providerInvoiceNumber: 'EXAMPLE-EXISTING',
    });
    assert.equal(reconciliation.resolution, 'CONFIRMED_EXISTING');
    await assert.rejects(provider.beginAttempt({
      authorizationId: existingCase.authorization.id,
      attemptKey: attemptKey('duplicate-danger'),
      provider: 'WAVE',
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'ALREADY_CONFIRMED' && error.statusCode === 409);

    const retryableCase = await authorizeDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'retryable',
    });
    const retryableAttempt = await provider.beginAttempt({
      authorizationId: retryableCase.authorization.id,
      attemptKey: attemptKey('retryable-first'),
      provider: 'WAVE',
    });
    await provider.recordOutcome({
      attemptId: retryableAttempt.id,
      outcome: 'FAILED_RETRYABLE',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    const allowedRetry = await provider.beginAttempt({
      authorizationId: retryableCase.authorization.id,
      attemptKey: attemptKey('retryable-second'),
      provider: 'WAVE',
    });
    assert.equal(allowedRetry.created, true);
    await provider.recordOutcome({
      attemptId: allowedRetry.id,
      outcome: 'FAILED_FINAL',
      providerInvoiceId: null,
      providerInvoiceNumber: null,
    });
    await assert.rejects(provider.beginAttempt({
      authorizationId: retryableCase.authorization.id,
      attemptKey: attemptKey('after-final'),
      provider: 'WAVE',
    }), error => error instanceof ProviderIssuanceError &&
      error.code === 'FINAL_FAILURE' && error.statusCode === 409);

    const draftRows = await pool.query(
      'SELECT status FROM invoice_drafts WHERE business_id=$1 ORDER BY created_at',
      [businessId]
    );
    assert.equal(draftRows.rows.length, 3);
    assert.ok(draftRows.rows.every(row => row.status === 'DRAFT'));

    const counts = await Promise.all([
      pool.query('SELECT count(*)::integer AS n FROM facturations_provider_issuance_attempts WHERE business_id=$1',
        [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_provider_issuance_results WHERE business_id=$1',
        [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_provider_issuance_reconciliations WHERE business_id=$1',
        [businessId]),
    ]);
    assert.equal(counts[0].rows[0].n, 5);
    assert.equal(counts[1].rows[0].n, 5);
    assert.equal(counts[2].rows[0].n, 2);

    await assert.rejects(
      pool.query(`DELETE FROM facturations_provider_issuance_results
                    WHERE business_id=$1 AND attempt_id=$2`, [businessId, first.id]),
      error => error.code === '23514'
    );
  } finally {
    await pool.end();
  }
});
