'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { previewDraft } = require('../src/draft-preview');
const { renderPrintable, attachBrowserOwnerPrint } = require('../src/browser-owner-print');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const ID = '22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(43);
const ORIGIN = 'https://fictional.example.test';
const BUSINESS = 'print-fixture';
const content = () => ({ currency: 'CAD', customer: { name: '<img src=x onerror=alert(1)> Société',
  email: 'recipient@example.test', address: 'Fictional office, Montréal' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: '<script>never execute</script>',
  lines: [{ description: 'Service & design', quantity: 2, unitPriceCents: 1500,
    discountCents: 200, taxable: true }],
  taxes: [{ code: 'TEST', label: 'Fictional tax', rateMilliPercent: 5000 }] });
function row(id = ID) {
  return { id, status: 'DRAFT', preview: { ...previewDraft(content()), status: 'DRAFT', persisted: true } };
}
function fixture() {
  const state = { role: 'OWNER', approved: true, revoked: false, reads: 0, approvalReads: 0 };
  const staffAuthStore = { async getSession(token) {
    return token === TOKEN && !state.revoked ? { id: OWNER, role: state.role, businessId: BUSINESS } : null;
  } };
  const draftStore = { async getDraft(id) { state.reads++; if (id !== ID) throw Error('not found'); return row(); } };
  const approvalStore = { async isApproved(input) { state.approvalReads++;
    assert.deepEqual(input, { draftId: ID, ownerId: OWNER, sessionToken: TOKEN });
    return state.approved;
  } };
  return { state, staffAuthStore, draftStore, approvalStore };
}
async function withServer(stores, run, businessId = BUSINESS) {
  const server = createServer({ config: { adminKey: '', businessId, waveToken: '' } });
  attachBrowserOwnerPrint(server, { origin: ORIGIN, businessId, ...stores });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = (token = TOKEN) => ({ Cookie: '__Host-facturations-session=' + token });
const path = `/internal/review/${ID}/print?lang=fr`;

test('FR/EN print view represents exact saved cents, escapes content and never claims issuance', () => {
  for (const lang of ['fr', 'en']) {
    const html = renderPrintable(row(), lang);
    assert.match(html, new RegExp(`<html lang="${lang}"`));
    assert.match(html, /GROUPE TAKATAK/);
    assert.match(html, /@page\{size:A4/);
    assert.match(html, /@media print/);
    assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<script\b|<img\b/i);
    assert.match(html, /Fictional tax/);
    assert.match(html, /5\.000%/);
    assert.match(html, /2,800|2\.800|28[,.]00/); // The discounted net is CAD 28.00.
    assert.match(html, lang === 'fr' ? /BROUILLON NON ÉMIS/ : /UNISSUED DRAFT/);
    assert.doesNotMatch(html, /invoiceSend|invoiceCreate|mailto:|waveSynced/);
  }
  const tampered = row();
  tampered.preview.totalCents += 1;
  assert.throws(() => renderPrintable(tampered, 'fr'), /totals mismatch/i);
  assert.throws(() => renderPrintable({ ...row(), status: 'ISSUED' }, 'en'));
  assert.throws(() => renderPrintable(row(), 'es'));
});

test('print HTTP requires an approved immutable draft and active OWNER session only', async () => {
  const stores = fixture();
  await withServer(stores, async base => {
    const request = (route = path, opts = {}) => fetch(base + route, opts);
    assert.equal((await request()).status, 401);
    assert.equal((await request(path, { headers: headers('Z'.repeat(43)) })).status, 401);
    assert.equal((await request(path, { headers: { ...headers(), Authorization: 'Bearer ' + TOKEN } })).status, 401);
    assert.equal((await request(path, { headers: { ...headers(), 'X-Admin-Key': 'admin' } })).status, 401);
    assert.equal(stores.state.approvalReads, 0);
    stores.state.role = 'STAFF';
    assert.equal((await request(path, { headers: headers() })).status, 403);
    stores.state.role = 'OWNER';
    stores.state.approved = false;
    assert.equal((await request(path, { headers: headers() })).status, 409);
    assert.equal(stores.state.reads, 0, 'Unapproved draft content must not be loaded');
    stores.state.approved = true;
    for (const route of [`/internal/review/${ID}/print?lang=es`, `${path}&secret=1`, `${path}&lang=en`]) {
      assert.equal((await request(route, { headers: headers() })).status, 422);
    }
    assert.equal((await request(path, { method: 'POST', headers: headers() })).status, 405);
    const response = await request(path, { headers: headers() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-security-policy').includes("form-action 'none'"), true);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(await response.text(), /BROUILLON NON ÉMIS/);
    const english = await request(`/internal/review/${ID}/print?lang=en`, { headers: headers() });
    assert.equal(english.status, 200);
    assert.match(await english.text(), /UNISSUED DRAFT/);
    stores.state.revoked = true;
    assert.equal((await request(path, { headers: headers() })).status, 401);
  });
  assert.throws(() => attachBrowserOwnerPrint(createServer({ config: {} }), {
    origin: 'http://fictional.example.test', businessId: BUSINESS,
    staffAuthStore: { getSession() {} }, draftStore: { getDraft() {} },
    approvalStore: { isApproved() {} },
  }), /Private OWNER print/);
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL: print only after OWNER internal approval, never changes draft',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, connectionTimeoutMillis: 5000 });
    const businessId = 'print-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId });
    const invitations = createStaffInvitationStore({ pool, businessId });
    const drafts = createDraftStore({ pool, businessId });
    const approvals = createDraftApprovalStore({ pool, businessId });
    try {
      const password = 'fictional-print-password-2026';
      const email = `owner-${crypto.randomUUID()}@example.test`;
      const owner = await auth.createPendingStaff({ email, password, role: 'OWNER' });
      const invitation = await invitations.issueInvitation({ staffId: owner.id });
      await invitations.redeemInvitation({ token: invitation.token, password });
      const session = await auth.authenticate({ email, password });
      const draft = await drafts.createDraft(content(), crypto.randomBytes(16).toString('hex'));
      await withServer({ staffAuthStore: auth, draftStore: drafts, approvalStore: approvals }, async base => {
        const route = `/internal/review/${draft.id}/print?lang=fr`;
        const visit = () => fetch(base + route, { headers: headers(session.token) });
        assert.equal((await visit()).status, 409, 'No printing before explicit approval');
        await approvals.approveDraft({ confirmation: 'APPROVE_DRAFT_ONLY', draftId: draft.id,
          ownerId: owner.id, sessionToken: session.token,
          expectedTotalCents: draft.preview.totalCents,
          expectedCustomerEmail: content().customer.email });
        const response = await visit();
        assert.equal(response.status, 200);
        assert.match(await response.text(), /BROUILLON NON ÉMIS/);
        const db = await pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
          [businessId, draft.id]);
        assert.equal(db.rows[0].status, 'DRAFT');
        const count = await pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1', [businessId]);
        assert.equal(count.rows[0].n, 1);
        await auth.revokeSession(session.token);
        assert.equal((await visit()).status, 401);
      }, businessId);
    } finally { await pool.end(); }
  });
