'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWorkspaceSubmissionStore, SubmissionError, validateSubmission } = require('../src/workspace-submission-store');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createDraftStore } = require('../src/draft-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(43);
const EMAIL = 'fictional@example.test';
const fields = Object.freeze({ confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY', workspaceId: ID,
  sessionToken: TOKEN, expectedRevision: 1, expectedTotalCents: 2500, expectedCustomerEmail: EMAIL });
function content(email = EMAIL) {
  return { currency: 'CAD', customer: { name: 'Fictional <client>', email, address: 'Test-only address' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Fake details, do not send',
    lines: [{ description: 'Imaginary service', quantity: 2, unitPriceCents: 1250,
      discountCents: 0, taxable: false }], taxes: [] };
}

test('submission requires a complete explicit intent, fixed revision and exact recipient/total', async () => {
  assert.deepEqual(validateSubmission(fields).expectedTotalCents, 2500);
  for (const invalid of [null, [], { ...fields, extra: true },
    { ...fields, confirmation: 'ISSUE_INVOICE' }, { ...fields, sessionToken: 'no' },
    { ...fields, workspaceId: 'no' }, { ...fields, expectedRevision: 0 },
    { ...fields, expectedRevision: 1.5 }, { ...fields, expectedTotalCents: '2500' },
    { ...fields, expectedCustomerEmail: 'bad\n@example.test' }]) {
    assert.throws(() => validateSubmission(invalid), error => error instanceof SubmissionError);
  }
  assert.throws(() => createWorkspaceSubmissionStore({ pool: {}, businessId: 'fake' }), /pool/);
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('PostgreSQL16: only owner of saved revision promotes once; frozen source and immutable link',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'promotion-' + crypto.randomUUID();
    const foreign = 'foreign-promotion-' + crypto.randomUUID();
    const password = 'fictional-only-password-2026';
    const ownerEmail = 'owner-' + crypto.randomUUID() + '@example.test';
    const staffEmail = 'staff-' + crypto.randomUUID() + '@example.test';
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    const invitation = createStaffInvitationStore({ pool, businessId: tenant });
    const spaces = createDraftWorkspaceStore({ pool, businessId: tenant });
    const submit = createWorkspaceSubmissionStore({ pool, businessId: tenant });
    try {
      const owner = await auth.createPendingStaff({ email: ownerEmail, password, role: 'OWNER' });
      const staff = await auth.createPendingStaff({ email: staffEmail, password, role: 'STAFF' });
      for (const person of [owner, staff]) {
        const issued = await invitation.issueInvitation({ staffId: person.id });
        await invitation.redeemInvitation({ token: issued.token, password });
      }
      const ownerSession = await auth.authenticate({ email: ownerEmail, password });
      const staffSession = await auth.authenticate({ email: staffEmail, password });
      const working = await spaces.create({ token: ownerSession.token,
        creationKey: crypto.randomBytes(16).toString('hex'), content: content() });
      const staffSpace = await spaces.create({ token: staffSession.token,
        creationKey: crypto.randomBytes(16).toString('hex'), content: content('staff@example.test') });
      const command = { ...fields, workspaceId: working.id, sessionToken: ownerSession.token };
      const denied = async (changes, status) => assert.rejects(submit.submit({ ...command, ...changes }),
        error => error instanceof SubmissionError && error.statusCode === status);
      await denied({ expectedTotalCents: 2501 }, 409);
      await denied({ expectedCustomerEmail: 'other@example.test' }, 409);
      await denied({ expectedRevision: 2 }, 409);
      await denied({ sessionToken: staffSession.token }, 403);
      await denied({ workspaceId: staffSpace.id }, 404);
      await assert.rejects(createWorkspaceSubmissionStore({ pool, businessId: foreign }).submit(command),
        error => error instanceof SubmissionError && error.statusCode === 403);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant])).rows[0].n, 0);

      const [first, retry] = await Promise.all([submit.submit(command), submit.submit(command)]);
      assert.equal(first.draftId, retry.draftId);
      assert.equal(first.created || retry.created, true);
      assert.equal(first.issued, false);
      assert.equal(first.waveSynced, false);
      assert.equal(first.emailed, false);
      const linked = await pool.query(
        `SELECT s.revision,s.draft_id,d.request_hash,d.snapshot,d.status
           FROM facturations_workspace_submissions s
           JOIN invoice_drafts d ON d.business_id=s.business_id AND d.id=s.draft_id
          WHERE s.business_id=$1 AND s.workspace_id=$2`, [tenant, working.id]
      );
      assert.equal(linked.rows.length, 1);
      assert.equal(linked.rows[0].revision, 1);
      assert.equal(linked.rows[0].draft_id, first.draftId);
      assert.equal(linked.rows[0].status, 'DRAFT');
      assert.equal(linked.rows[0].snapshot.totalCents, 2500);
      assert.equal(linked.rows[0].snapshot.customer.email, EMAIL);
      assert.equal((await createDraftStore({ pool, businessId: tenant }).getDraft(first.draftId)).status, 'DRAFT');
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM invoice_audit_events WHERE business_id=$1', [tenant])).rows[0].n, 1);
      await assert.rejects(pool.query('UPDATE facturations_workspace_submissions SET revision=2 WHERE business_id=$1 AND workspace_id=$2',
        [tenant, working.id]), error => error.code === '23514');
      await assert.rejects(pool.query('DELETE FROM facturations_workspace_submissions WHERE business_id=$1 AND workspace_id=$2',
        [tenant, working.id]), error => error.code === '23514');
      await assert.rejects(pool.query("UPDATE facturations_draft_workspaces SET content='{}'::jsonb,revision=revision+1 WHERE business_id=$1 AND id=$2",
        [tenant, working.id]), error => error.code === '23514');
      await assert.rejects(spaces.save({ token: ownerSession.token, workspaceId: working.id,
        expectedRevision: 1, content: content() }));
      assert.equal((await spaces.load({ token: ownerSession.token, workspaceId: working.id })).revision, 1);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant])).rows[0].n, 1);
      assert.equal(await auth.revokeSession(ownerSession.token), true);
      await denied({}, 403);
    } finally { await pool.end(); }
  });
