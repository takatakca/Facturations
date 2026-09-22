'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserOwnerReview } = require('../src/browser-owner-review');
const { previewDraft } = require('../src/draft-preview');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createDashboardStore } = require('../src/dashboard-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const ORIGIN = 'https://fictional.example.test';
const TENANT = 'review-fixture';
const TOKEN = 'A'.repeat(43);
const KEY = 'b'.repeat(64);
const OWNER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const PATH = `/internal/review/${ID}?lang=fr`;
const EMAIL = 'fictional@example.test';
const bodyFor = (csrf, changes = {}) => new URLSearchParams({
  csrf, confirmation: 'APPROVE_DRAFT_ONLY', expectedTotalCents: '2500',
  expectedCustomerEmail: EMAIL, recipientReviewed: 'yes', amountReviewed: 'yes',
  datesReviewed: 'yes', taxesReviewed: 'yes', ...changes,
}).toString();
function input() {
  return { currency: 'CAD', customer: { name: '<script> & Société', email: EMAIL, address: 'Fictional address' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Synthetic only',
    lines: [{ description: 'Example & service', quantity: 1, unitPriceCents: 2500, taxable: false }], taxes: [] };
}
const draft = () => ({ id: ID, status: 'DRAFT', preview: { ...previewDraft(input()),
  status: 'DRAFT', persisted: true } });
function fake() {
  const state = { role: 'OWNER', revoked: false, fail: false, calls: 0, writes: 0, captured: null };
  const staffAuthStore = { async getSession(token) {
    if (state.fail) throw Error('private auth error');
    return token === TOKEN && !state.revoked ? { id: OWNER, role: state.role, businessId: TENANT } : null;
  } };
  const dashboardStore = { async listDrafts() { return { status: 'DRAFTS_ONLY', drafts: [
    { id: ID, status: 'DRAFT', currency: 'CAD', customerName: '<script> & Société',
      invoiceDate: '2026-09-20', totalCents: '2500' },
  ] }; } };
  const draftStore = { async getDraft(id) {
    state.calls++;
    if (id !== ID) throw Error('not found');
    return draft();
  } };
  const approvalStore = { async approveDraft(command) { state.writes++; state.captured = command;
    return { status: 'APPROVED_INTERNAL_ONLY', issued: false, waveSynced: false, emailed: false };
  } };
  return { state, staffAuthStore, dashboardStore, draftStore, approvalStore };
}
async function withServer(stores, run, tenant = TENANT) {
  const app = createServer({ config: { businessId: tenant, adminKey: 'fictional-private-admin', waveToken: null } });
  attachBrowserOwnerReview(app, { origin: ORIGIN, encryptionKeyHex: KEY, businessId: tenant, ...stores });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  try { await run(`http://127.0.0.1:${app.address().port}`); }
  finally { await new Promise(resolve => app.close(resolve)); }
}
function getHeaders(token = TOKEN) { return { Cookie: `__Host-facturations-session=${token}` }; }
function postHeaders(token = TOKEN) { return { ...getHeaders(token), Host: 'fictional.example.test',
  Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }; }
async function sendPost(base, csrf, overrides = {}, headers = postHeaders(), path = PATH) {
  return fetch(base + path, { method: 'POST', headers, body: bodyFor(csrf, overrides), redirect: 'manual' });
}
function readCsrf(html) {
  const match = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html);
  assert.ok(match, 'Actual hidden review CSRF token required');
  return match[1];
}

test('review rejects unauthenticated, STAFF, bearer/admin and malformed routes', async () => {
  const stores = fake();
  await withServer(stores, async base => {
    for (const path of ['/internal/review?lang=fr', PATH]) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: getHeaders('Z'.repeat(43)) })).status, 401);
      assert.equal((await fetch(base + path, { headers: { ...getHeaders(), Authorization: 'Bearer ' + TOKEN } })).status, 401);
      assert.equal((await fetch(base + path, { headers: { ...getHeaders(), 'X-Admin-Key': 'fictional-private-admin' } })).status, 401);
    }
    stores.state.role = 'STAFF';
    assert.equal((await fetch(base + PATH, { headers: getHeaders() })).status, 403);
    stores.state.role = 'OWNER';
    for (const path of ['/internal/review?lang=es', '/internal/review?lang=fr&lang=en',
      `/internal/review/${ID}?lang=fr&token=private`, '/internal/review/not-uuid?lang=fr']) {
      assert.equal((await fetch(base + path, { headers: getHeaders() })).status, 422);
    }
    assert.equal((await fetch(base + '/internal/review?lang=fr', { method: 'POST', headers: getHeaders() })).status, 405);
    stores.state.revoked = true;
    assert.equal((await fetch(base + PATH, { headers: getHeaders() })).status, 401);
    stores.state.revoked = false; stores.state.fail = true;
    assert.equal((await fetch(base + PATH, { headers: getHeaders() })).status, 503);
    assert.equal(stores.state.writes, 0);
  });
  assert.throws(() => attachBrowserOwnerReview({ listeners: () => [] }, {}), /Dedicated/);
});

test('owner sees escaped immutable snapshot and deliberate unchecked internal-only acknowledgement', async () => {
  const stores = fake();
  await withServer(stores, async base => {
    const listing = await fetch(base + '/internal/review?lang=en', { headers: getHeaders() });
    assert.equal(listing.status, 200);
    const listHtml = await listing.text();
    assert.match(listHtml, /&lt;script&gt; &amp; Société/);
    assert.match(listHtml, new RegExp(`/internal/review/${ID}\\?lang=en`));
    assert.doesNotMatch(listHtml, new RegExp(EMAIL));
    const response = await fetch(base + PATH, { headers: getHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(response.headers.get('set-cookie'), null);
    const html = await response.text();
    assert.match(html, /&lt;script&gt; &amp; Société/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /APPROVE_DRAFT_ONLY/);
    assert.match(html, /name="expectedCustomerEmail" value="fictional@example.test"/);
    assert.match(html, /Aucune facture émise ou envoyée|aucune facture Wave/i);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 4);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
    assert.doesNotMatch(html, /fictional-private-admin/);
    assert.ok(readCsrf(html));
    assert.equal(stores.state.writes, 0);
  });
});

test('owner POST requires exact Origin, CSRF, reviewed fields and preserved expected details', async () => {
  const stores = fake();
  await withServer(stores, async base => {
    const html = await (await fetch(base + PATH, { headers: getHeaders() })).text();
    const csrf = readCsrf(html);
    for (const headers of [postHeaders(TOKEN), { ...postHeaders(), Origin: 'https://other.example.test' },
      { ...postHeaders(), Host: 'other.example.test' }, { ...postHeaders(), 'Sec-Fetch-Site': 'cross-site' }].slice(1)) {
      assert.equal((await sendPost(base, csrf, {}, headers)).status, 403);
    }
    assert.equal((await sendPost(base, 'X'.repeat(43))).status, 403);
    assert.equal((await sendPost(base, csrf, { confirmation: 'ISSUE_NOW' })).status, 422);
    assert.equal((await sendPost(base, csrf, { taxesReviewed: 'no' })).status, 422);
    assert.equal((await sendPost(base, csrf, { expectedTotalCents: '25.00' })).status, 422);
    assert.equal((await sendPost(base, csrf, {}, { ...postHeaders(), 'Content-Type': 'application/json' })).status, 415);
    const duplicated = await fetch(base + PATH, { method: 'POST', headers: postHeaders(),
      body: bodyFor(csrf) + '&csrf=' + csrf });
    assert.equal(duplicated.status, 422);
    assert.equal(stores.state.writes, 0);
    const accepted = await sendPost(base, csrf);
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /Approbation interne enregistrée/);
    assert.equal(stores.state.writes, 1);
    assert.deepEqual(stores.state.captured, {
      confirmation: 'APPROVE_DRAFT_ONLY', draftId: ID, ownerId: OWNER,
      sessionToken: TOKEN, expectedTotalCents: 2500, expectedCustomerEmail: EMAIL,
    });
  });
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL owner review records one internal approval only; rejects STAFF, foreign tenant and revoked session',
  { skip: !DATABASE }, async () => {
    const database = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname));
    assert.equal(database.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'review-' + crypto.randomUUID();
    const foreign = 'foreign-review-' + crypto.randomUUID();
    const password = 'fictional-review-password-2026';
    const ownerEmail = 'owner-' + crypto.randomUUID() + '@example.test';
    const staffEmail = 'staff-' + crypto.randomUUID() + '@example.test';
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    const invites = createStaffInvitationStore({ pool, businessId: tenant });
    try {
      const owner = await auth.createPendingStaff({ email: ownerEmail, password, role: 'OWNER' });
      const staff = await auth.createPendingStaff({ email: staffEmail, password, role: 'STAFF' });
      for (const member of [owner, staff]) {
        const invite = await invites.issueInvitation({ staffId: member.id });
        await invites.redeemInvitation({ token: invite.token, password });
      }
      const ownerSession = await auth.authenticate({ email: ownerEmail, password });
      const staffSession = await auth.authenticate({ email: staffEmail, password });
      const drafts = createDraftStore({ pool, businessId: tenant });
      const created = await drafts.createDraft(input(), crypto.randomBytes(16).toString('hex'));
      const stores = { staffAuthStore: auth, dashboardStore: createDashboardStore({ pool, businessId: tenant }),
        draftStore: drafts, approvalStore: createDraftApprovalStore({ pool, businessId: tenant }) };
      const route = `/internal/review/${created.id}?lang=fr`;
      await withServer(stores, async base => {
        const ownerHeaders = getHeaders(ownerSession.token);
        assert.equal((await fetch(base + route, { headers: getHeaders(staffSession.token) })).status, 403);
        assert.equal((await fetch(base + route, { headers: getHeaders('X'.repeat(43)) })).status, 401);
        const foreignDrafts = createDraftStore({ pool, businessId: foreign });
        const foreignRow = await foreignDrafts.createDraft(input(), crypto.randomBytes(16).toString('hex'));
        assert.equal((await fetch(base + `/internal/review/${foreignRow.id}?lang=fr`, { headers: ownerHeaders })).status, 404);
        const html = await (await fetch(base + route, { headers: ownerHeaders })).text();
        const csrf = readCsrf(html);
        const headers = postHeaders(ownerSession.token);
        assert.equal((await sendPost(base, csrf, { expectedTotalCents: '2501' }, headers, route)).status, 409);
        assert.equal((await sendPost(base, csrf, { expectedCustomerEmail: 'other@example.test' }, headers, route)).status, 409);
        const first = await sendPost(base, csrf, {}, headers, route);
        assert.equal(first.status, 200);
        assert.match(await first.text(), /Approbation interne enregistrée/);
        const retry = await sendPost(base, csrf, {}, headers, route);
        assert.equal(retry.status, 200);
        const count = await pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1', [tenant]);
        assert.equal(count.rows[0].n, 1);
        const unchanged = await pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2', [tenant, created.id]);
        assert.equal(unchanged.rows[0].status, 'DRAFT');
        assert.equal(await auth.revokeSession(ownerSession.token), true);
        assert.equal((await sendPost(base, csrf, {}, headers, route)).status, 401);
      }, tenant);
    } finally { await pool.end(); }
  });
