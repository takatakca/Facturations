'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserOwnerReview } = require('../src/browser-owner-review');
const { createDraftApprovalStore, DraftApprovalError } = require('../src/draft-approval-store');
const { createDraftStore } = require('../src/draft-store');
const { createDashboardStore } = require('../src/dashboard-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-status-password-2026';
const EMAIL = 'status-client@example.test';
function example() {
  return { currency: 'CAD', customer: { name: 'Example status customer', email: EMAIL },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20',
    lines: [{ description: 'Synthetic status check', quantity: 1, unitPriceCents: 2500,
      discountCents: 0, taxable: false }], taxes: [] };
}
async function enroll(auth, invites, role) {
  const user = await auth.createPendingStaff({
    email: 'status-' + crypto.randomUUID() + '@example.test', password: PASSWORD, role,
  });
  const invitation = await invites.issueInvitation({ staffId: user.id });
  await invites.redeemInvitation({ token: invitation.token, password: PASSWORD });
  return { user, session: await auth.authenticate({ email: user.email, password: PASSWORD }) };
}

test('PostgreSQL: owner reload shows persisted internal approval in FR/EN without a second approval form',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const businessId = 'status-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId });
    const invites = createStaffInvitationStore({ pool, businessId });
    const drafts = createDraftStore({ pool, businessId });
    const approvals = createDraftApprovalStore({ pool, businessId });
    const app = createServer({ config: { businessId, adminKey: '', waveToken: '' } });
    let listening = false;
    try {
      const owner = await enroll(auth, invites, 'OWNER');
      const staff = await enroll(auth, invites, 'STAFF');
      const record = await drafts.createDraft(example(), crypto.randomBytes(16).toString('hex'));
      attachBrowserOwnerReview(app, { origin: 'https://facturations.example.test',
        encryptionKeyHex: 'b'.repeat(64), businessId, staffAuthStore: auth,
        dashboardStore: createDashboardStore({ pool, businessId }),
        draftStore: drafts, approvalStore: approvals });
      app.listen(0, '127.0.0.1');
      await once(app, 'listening');
      listening = true;
      const base = `http://127.0.0.1:${app.address().port}`;
      const view = (lang, token = owner.session.token) => fetch(
        `${base}/internal/review/${record.id}?lang=${lang}`,
        { headers: { Cookie: '__Host-facturations-session=' + token } });
      const initial = await view('fr');
      assert.equal(initial.status, 200);
      assert.match(await initial.text(), /name="confirmation" value="APPROVE_DRAFT_ONLY"/);
      assert.equal(await approvals.isApproved({ draftId: record.id,
        ownerId: owner.user.id, sessionToken: owner.session.token }), false);
      assert.equal((await view('fr', staff.session.token)).status, 403);
      await assert.rejects(approvals.isApproved({ draftId: record.id,
        ownerId: staff.user.id, sessionToken: staff.session.token }),
      error => error instanceof DraftApprovalError && error.statusCode === 403);

      const decision = await approvals.approveDraft({ confirmation: 'APPROVE_DRAFT_ONLY',
        draftId: record.id, ownerId: owner.user.id, sessionToken: owner.session.token,
        expectedTotalCents: 2500, expectedCustomerEmail: EMAIL });
      assert.equal(decision.status, 'APPROVED_INTERNAL_ONLY');
      assert.equal(await approvals.isApproved({ draftId: record.id,
        ownerId: owner.user.id, sessionToken: owner.session.token }), true);
      for (const [lang, message] of [['fr', 'Approbation interne enregistrée'],
        ['en', 'Internal approval recorded']]) {
        const refreshed = await view(lang);
        assert.equal(refreshed.status, 200);
        assert.equal(refreshed.headers.get('cache-control'), 'private, no-store');
        const html = await refreshed.text();
        assert.ok(html.includes(message));
        assert.doesNotMatch(html, /name="confirmation"|name="csrf"|type="checkbox"/);
        assert.doesNotMatch(html, /APPROVE_DRAFT_ONLY/);
      }
      const stored = await pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [businessId, record.id]);
      assert.equal(stored.rows[0].status, 'DRAFT', 'Internal approval cannot issue an invoice');
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1',
        [businessId])).rows[0].n, 1);
      await auth.revokeSession(owner.session.token);
      assert.equal((await view('fr')).status, 401);
      await assert.rejects(approvals.isApproved({ draftId: record.id,
        ownerId: owner.user.id, sessionToken: owner.session.token }),
      error => error instanceof DraftApprovalError && error.statusCode === 403);
    } finally {
      if (listening) await new Promise(resolve => app.close(resolve));
      await pool.end();
    }
  });
