'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createProviderIssuanceAttemptStore } = require('../src/provider-issuance-attempt-store');
const { createProviderIssuanceExecutor } = require('../src/provider-issuance-executor');
const {
  createIssuedInvoiceRegistry,
  IssuedInvoiceRegistryError,
} = require('../src/issued-invoice-registry');
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
    notes: 'Issued registry test only',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'issued_' + crypto.randomBytes(16).toString('hex'));

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

test('local issued registry materializes only confirmed provider results and remains immutable', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issued-registry-' + crypto.randomUUID();
  const password = 'synthetic-issued-registry-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });
  const registry = createIssuedInvoiceRegistry({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invitations, password });

    const confirmedFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'confirmed',
    });
    const prepared = await attempts.prepare({
      authorizationId: confirmedFixture.authorization.id,
    });
    const executor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          return {
            status: 'CONFIRMED',
            providerInvoiceId: 'wave-issued-' + crypto.randomUUID(),
            providerInvoiceNumber: 'SYNTHETIC-' + crypto.randomUUID().slice(0, 8),
          };
        },
      },
    });
    const confirmed = await executor.execute({
      attemptId: prepared.id,
      payload: confirmedFixture.payload,
    });

    const issued = await registry.materialize({ attemptId: confirmed.id });
    assert.equal(issued.attemptId, confirmed.id);
    assert.equal(issued.authorizationId, confirmedFixture.authorization.id);
    assert.equal(issued.draftId, confirmedFixture.draft.id);
    assert.equal(issued.providerInvoiceId, confirmed.providerInvoiceId);
    assert.equal(issued.officialInvoiceNumber, confirmed.providerInvoiceNumber);
    assert.equal(issued.status, 'ISSUED_CONFIRMED');
    assert.equal(issued.deliveryState, 'NOT_AUTHORIZED');
    assert.equal(issued.issued, true);
    assert.equal(issued.providerConfirmed, true);
    assert.equal(issued.deliveryAuthorized, false);
    assert.equal(issued.emailed, false);

    const repeated = await registry.materialize({ attemptId: confirmed.id });
    assert.equal(repeated.id, issued.id, 'materialization is idempotent');

    const found = await registry.getByAttempt({ attemptId: confirmed.id });
    assert.equal(found.id, issued.id);

    const pendingFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'pending',
    });
    const pending = await attempts.prepare({ authorizationId: pendingFixture.authorization.id });
    await assert.rejects(
      registry.materialize({ attemptId: pending.id }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'PROVIDER_CONFIRMATION_REQUIRED' &&
        error.statusCode === 409
    );

    const mismatchA = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'mismatch-a',
    });
    const mismatchB = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'mismatch-b',
    });
    const inconsistent = await pool.query(
      `INSERT INTO facturations_provider_issuance_attempts
         (business_id,authorization_id,draft_id,provider,operation_key,state,
          provider_invoice_id,provider_invoice_number,started_at,finished_at)
       VALUES ($1,$2,$3,'WAVE',$4,'CONFIRMED',$5,$6,now(),now())
       RETURNING id`,
      [
        businessId,
        mismatchA.authorization.id,
        mismatchB.draft.id,
        'wave_' + crypto.randomBytes(32).toString('base64url'),
        'wave-mismatch-' + crypto.randomUUID(),
        'SYNTHETIC-MISMATCH-' + crypto.randomUUID().slice(0, 8),
      ]
    );
    await assert.rejects(
      registry.materialize({ attemptId: inconsistent.rows[0].id }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ISSUANCE_CHAIN_MISMATCH' &&
        error.statusCode === 409
    );

    const foreign = createIssuedInvoiceRegistry({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.materialize({ attemptId: confirmed.id }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ATTEMPT_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_issued_invoices SET delivery_state='NOT_AUTHORIZED'
          WHERE business_id=$1 AND id=$2`,
        [businessId, issued.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issued_invoices WHERE business_id=$1 AND id=$2',
        [businessId, issued.id]
      ),
      error => error && error.code === '23514'
    );

    const [draftRows, authRows, issuedRows] = await Promise.all([
      pool.query(
        'SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [businessId, confirmedFixture.draft.id]
      ),
      pool.query(
        'SELECT state FROM facturations_issuance_authorizations WHERE business_id=$1 AND id=$2',
        [businessId, confirmedFixture.authorization.id]
      ),
      pool.query(
        'SELECT count(*)::integer AS n FROM facturations_issued_invoices WHERE business_id=$1',
        [businessId]
      ),
    ]);
    assert.deepEqual(draftRows.rows, [{ status: 'DRAFT' }]);
    assert.deepEqual(authRows.rows, [{ state: 'AUTHORIZED_PENDING_PROVIDER' }]);
    assert.deepEqual(issuedRows.rows, [{ n: 1 }]);
  } finally {
    await pool.end();
  }
});
