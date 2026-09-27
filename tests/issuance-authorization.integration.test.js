'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const {
  createIssuanceAuthorizationStore,
  IssuanceAuthorizationError,
} = require('../src/issuance-authorization-store');

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

test('owner authorization is a separate immutable gate after internal approval and never issues', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issuance-gate-' + crypto.randomUUID();
  const password = 'fictional-issuance-gate-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invites = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invites, password });
    const customerEmail = 'customer-' + crypto.randomUUID() + '@example.test';
    const draft = await drafts.createDraft({
      currency: 'CAD',
      customer: { name: 'Synthetic Customer', email: customerEmail, address: 'Example only' },
      invoiceDate: '2026-09-22',
      dueDate: '2026-10-22',
      notes: 'No external provider call',
      lines: [{ description: 'Synthetic service', quantity: 2, unitPriceCents: 1500, taxable: false }],
      taxes: [],
    }, 'issuance_' + crypto.randomBytes(12).toString('hex'));

    const command = {
      confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      draftId: draft.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedTotalCents: 3000,
      expectedCustomerEmail: customerEmail,
      provider: 'WAVE',
    };

    await assert.rejects(authorizations.authorize(command), error =>
      error instanceof IssuanceAuthorizationError &&
      error.code === 'INTERNAL_APPROVAL_REQUIRED' &&
      error.statusCode === 409);

    const approval = await approvals.approveDraft({
      confirmation: 'APPROVE_DRAFT_ONLY',
      draftId: draft.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedTotalCents: 3000,
      expectedCustomerEmail: customerEmail,
    });
    assert.equal(approval.status, 'APPROVED_INTERNAL_ONLY');

    await assert.rejects(authorizations.authorize({ ...command, expectedTotalCents: 3001 }), error =>
      error instanceof IssuanceAuthorizationError &&
      error.code === 'AUTHORIZATION_DETAILS_CHANGED' &&
      error.statusCode === 409);

    const authorized = await authorizations.authorize(command);
    assert.equal(authorized.status, 'AUTHORIZED_PENDING_PROVIDER');
    assert.equal(authorized.provider, 'WAVE');
    assert.equal(authorized.issued, false);
    assert.equal(authorized.waveSynced, false);
    assert.equal(authorized.emailed, false);

    const persisted = await authorizations.getAuthorization({
      draftId: draft.id, ownerId: owner.id, sessionToken: session.token,
    });
    assert.equal(persisted.id, authorized.id);
    assert.equal(persisted.status, 'AUTHORIZED_PENDING_PROVIDER');

    const retry = await authorizations.authorize(command);
    assert.equal(retry.id, authorized.id, 'same owner and exact snapshot is idempotent');

    const second = await provisionOwner({ auth, invites, password: password + '-second' });
    await assert.rejects(authorizations.authorize({
      ...command, ownerId: second.owner.id, sessionToken: second.session.token,
    }), error =>
      error instanceof IssuanceAuthorizationError &&
      error.code === 'ALREADY_AUTHORIZED' &&
      error.statusCode === 409);

    const [draftRows, authRows, auditRows] = await Promise.all([
      pool.query('SELECT status,snapshot FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [businessId, draft.id]),
      pool.query(`SELECT state,provider,expected_total_cents,expected_customer_email
                    FROM facturations_issuance_authorizations
                   WHERE business_id=$1 AND draft_id=$2`, [businessId, draft.id]),
      pool.query('SELECT action FROM invoice_audit_events WHERE business_id=$1 AND draft_id=$2',
        [businessId, draft.id]),
    ]);
    assert.equal(draftRows.rows[0].status, 'DRAFT');
    assert.equal(draftRows.rows[0].snapshot.totalCents, 3000);
    assert.equal(authRows.rows.length, 1);
    assert.equal(authRows.rows[0].state, 'AUTHORIZED_PENDING_PROVIDER');
    assert.equal(authRows.rows[0].provider, 'WAVE');
    assert.equal(Number(authRows.rows[0].expected_total_cents), 3000);
    assert.equal(authRows.rows[0].expected_customer_email, customerEmail.toLowerCase());
    assert.deepEqual(auditRows.rows.map(row => row.action), ['DRAFT_CREATED']);

    await assert.rejects(
      pool.query(`UPDATE facturations_issuance_authorizations SET provider='WAVE'
                   WHERE business_id=$1 AND draft_id=$2`, [businessId, draft.id]),
      error => error.code === '23514',
      'authorization row is append-only'
    );

    await auth.revokeSession(session.token);
    await assert.rejects(authorizations.getAuthorization({
      draftId: draft.id, ownerId: owner.id, sessionToken: session.token,
    }), error => error instanceof IssuanceAuthorizationError && error.statusCode === 403);
    await assert.rejects(authorizations.authorize(command), error =>
      error instanceof IssuanceAuthorizationError && error.statusCode === 403);
  } finally {
    await pool.end();
  }
});
