'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDraftStore } = require('../src/draft-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftApprovalStore, DraftApprovalError, validateApproval } = require('../src/draft-approval-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-approval-password-2026';
const BAD = error => error instanceof DraftApprovalError;
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const BASE = Object.freeze({
  confirmation: 'APPROVE_DRAFT_ONLY', draftId: DRAFT_ID, ownerId: OWNER_ID,
  sessionToken: 'A'.repeat(43), expectedTotalCents: 2599,
  expectedCustomerEmail: 'fictional@example.test',
});

function draftFor(email) {
  return { currency: 'CAD', customer: { name: 'Synthetic example', email },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20',
    lines: [{ description: 'Fictional service', quantity: 1, unitPriceCents: 2599, taxable: false }],
    taxes: [] };
}

test('internal approval rejects missing explicit intent, bad identifiers, changes and extra fields before DB access', async () => {
  const pool = { query() { throw Error('DB must not be reached'); }, connect() { throw Error('DB must not be reached'); } };
  const approvals = createDraftApprovalStore({ pool, businessId: 'fictional-business' });
  assert.throws(() => createDraftApprovalStore({ pool, businessId: '' }), /business ID/);
  assert.deepEqual(validateApproval(BASE).expectedTotalCents, 2599);
  for (const input of [null, [], { ...BASE, extra: true }, { ...BASE, confirmation: 'SEND_NOW' },
    { ...BASE, draftId: 'bad' }, { ...BASE, ownerId: 'bad' }, { ...BASE, sessionToken: 'bad' },
    { ...BASE, expectedTotalCents: 25.99 }, { ...BASE, expectedTotalCents: -1 },
    { ...BASE, expectedCustomerEmail: 'invalid' }, { ...BASE, expectedCustomerEmail: 'bad\n@example.test' }]) {
    await assert.rejects(approvals.approveDraft(input), BAD);
  }
});

test('disposable PostgreSQL: owner must confirm exact snapshot, cannot cross tenants, approval is append-only',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'approval-' + crypto.randomUUID();
    const foreignTenant = 'foreign-approval-' + crypto.randomUUID();
    const email = 'owner-' + crypto.randomUUID() + '@example.test';
    const customerEmail = 'customer-' + crypto.randomUUID() + '@example.test';
    const staffEmail = 'staff-' + crypto.randomUUID() + '@example.test';
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    const invites = createStaffInvitationStore({ pool, businessId: tenant });
    const approvals = createDraftApprovalStore({ pool, businessId: tenant });
    const drafts = createDraftStore({ pool, businessId: tenant });
    try {
      const owner = await auth.createPendingStaff({ email, password: PASSWORD, role: 'OWNER' });
      const staff = await auth.createPendingStaff({ email: staffEmail, password: PASSWORD, role: 'STAFF' });
      for (const user of [owner, staff]) {
        const invite = await invites.issueInvitation({ staffId: user.id });
        await invites.redeemInvitation({ token: invite.token, password: PASSWORD });
      }
      const ownerSession = await auth.authenticate({ email, password: PASSWORD });
      const staffSession = await auth.authenticate({ email: staffEmail, password: PASSWORD });
      const created = await drafts.createDraft(draftFor(customerEmail), crypto.randomUUID().replace(/-/g, ''));
      const command = { confirmation: 'APPROVE_DRAFT_ONLY', draftId: created.id, ownerId: owner.id,
        sessionToken: ownerSession.token, expectedTotalCents: 2599, expectedCustomerEmail: customerEmail };
      const rejects = async (changes, code) => assert.rejects(approvals.approveDraft({ ...command, ...changes }),
        error => BAD(error) && error.code === code);

      await rejects({ expectedTotalCents: 2600 }, 'APPROVAL_DETAILS_CHANGED');
      await rejects({ expectedCustomerEmail: 'other@example.test' }, 'APPROVAL_DETAILS_CHANGED');
      await rejects({ ownerId: staff.id, sessionToken: staffSession.token }, 'OWNER_AUTH_REQUIRED');
      await rejects({ ownerId: crypto.randomUUID() }, 'OWNER_AUTH_REQUIRED');
      await rejects({ draftId: crypto.randomUUID() }, 'DRAFT_NOT_FOUND');
      await rejects({ sessionToken: 'X'.repeat(43) }, 'OWNER_AUTH_REQUIRED');
      await assert.rejects(createDraftApprovalStore({ pool, businessId: foreignTenant }).approveDraft(command),
        error => BAD(error) && error.code === 'OWNER_AUTH_REQUIRED');
      let existing = await pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1', [tenant]);
      assert.equal(existing.rows[0].n, 0);

      const [first, retry] = await Promise.all([approvals.approveDraft(command), approvals.approveDraft(command)]);
      assert.deepEqual(first, retry);
      assert.equal(first.status, 'APPROVED_INTERNAL_ONLY');
      assert.equal(first.issued, false);
      assert.equal(first.waveSynced, false);
      assert.equal(first.emailed, false);
      existing = await pool.query('SELECT id,request_hash FROM facturations_draft_approvals WHERE business_id=$1', [tenant]);
      assert.equal(existing.rows.length, 1);
      const draftRow = await pool.query('SELECT request_hash,status FROM invoice_drafts WHERE business_id=$1 AND id=$2', [tenant, created.id]);
      assert.equal(existing.rows[0].request_hash, draftRow.rows[0].request_hash);
      assert.equal(draftRow.rows[0].status, 'DRAFT');

      await assert.rejects(pool.query('UPDATE facturations_draft_approvals SET approved_by=$1 WHERE id=$2',
        [staff.id, existing.rows[0].id]), error => error.code === '23514');
      await assert.rejects(pool.query('DELETE FROM facturations_draft_approvals WHERE id=$1',
        [existing.rows[0].id]), error => error.code === '23514');
      assert.equal(await auth.revokeSession(ownerSession.token), true);
      await rejects({}, 'OWNER_AUTH_REQUIRED');
      // Even a revoked owner cannot create further internal approvals.
      const second = await drafts.createDraft(draftFor('second-' + crypto.randomUUID() + '@example.test'),
        crypto.randomUUID().replace(/-/g, ''));
      await rejects({ draftId: second.id, expectedCustomerEmail: second.preview.customer.email }, 'OWNER_AUTH_REQUIRED');
    } finally {
      await pool.end();
    }
  });
