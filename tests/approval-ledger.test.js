'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { createDraftStore } = require('../src/draft-store');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createApprovalLedger, ApprovalLedgerError, approvalPageOptions } = require('../src/approval-ledger');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const TOKEN = 'Q'.repeat(43); // Fictional, never a live credential.
const ADMIN = 'k'.repeat(64); // Synthetic private service-key fixture.
const BUSINESS = 'fictional-approval-ledger-business';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';

async function withServer({ role = 'OWNER', authStore, ledger } = {}, run) {
  const calls = { approvals: 0, wave: 0 };
  const server = createServer({
    config: { businessId: BUSINESS, adminKey: ADMIN, waveToken: 'fictional-only' },
    staffAuthStore: authStore ?? { async getSession(token) {
      return token === TOKEN ? { id: OWNER_ID, businessId: BUSINESS, role } : null;
    } },
    approvalLedger: ledger ?? { async listApprovals(options) {
      calls.approvals++;
      return { status: 'INTERNAL_APPROVALS_ONLY', ...options, approvals: [], hasMore: false };
    } },
    fetchImpl: async () => { calls.wave++; throw Error('Wave must not be called'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const bearer = { Authorization: `Bearer ${TOKEN}` };
function urlOptions(query) { return approvalPageOptions(new URLSearchParams(query)); }

test('approval listing rejects unexpected/duplicate query parameters and bounds pagination', () => {
  assert.deepEqual(urlOptions(''), { page: 1, pageSize: 20, offset: 0 });
  assert.deepEqual(urlOptions('page=2&pageSize=3'), { page: 2, pageSize: 3, offset: 3 });
  for (const query of ['q=abc', 'page=1&page=2', 'page=0', 'pageSize=0',
    'pageSize=51', 'page=1001', 'page=1.2', 'pageSize=1&pageSize=2']) {
    assert.throws(() => urlOptions(query), error => error instanceof ApprovalLedgerError || error.code?.startsWith('INVALID_'));
  }
  assert.throws(() => createApprovalLedger({ pool: { query() {} }, businessId: '' }), /business ID/);
});

test('only OWNER or private service may list approvals; failed sessions never fall back to admin', async () => {
  await withServer({ role: 'STAFF' }, async (base, calls) => {
    const denied = await fetch(base + '/api/approvals', { headers: bearer });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.approvals, 0);
  });
  await withServer({}, async (base, calls) => {
    const missing = await fetch(base + '/api/approvals');
    assert.equal(missing.status, 401);
    const malformed = await fetch(base + '/api/approvals',
      { headers: { Authorization: 'Bearer invalid', 'X-Admin-Key': ADMIN } });
    assert.equal(malformed.status, 401);
    const valid = await fetch(base + '/api/approvals?page=2&pageSize=4', { headers: bearer });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    const result = await valid.json();
    assert.equal(result.status, 'INTERNAL_APPROVALS_ONLY');
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 4);
    const admin = await fetch(base + '/api/approvals', { headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(admin.status, 200);
    for (const query of ['?q=hi', '?page=0', '?page=2&page=3', '?pageSize=51']) {
      assert.equal((await fetch(base + '/api/approvals' + query, { headers: bearer })).status, 422);
    }
    assert.equal((await fetch(base + '/api/approvals', { method: 'POST', headers: bearer })).status, 405);
    assert.equal(calls.approvals, 2);
    assert.equal(calls.wave, 0);
  });
  await withServer({ authStore: { async getSession() {
    return { id: OWNER_ID, businessId: 'foreign-tenant', role: 'OWNER' };
  } } }, async (base, calls) => {
    assert.equal((await fetch(base + '/api/approvals', { headers: bearer })).status, 401);
    assert.equal(calls.approvals, 0);
  });
});

test('approval history fails closed and never exposes database exception text', async () => {
  await withServer({ ledger: { async listApprovals() { throw Error('private database secret'); } } },
    async base => {
      const response = await fetch(base + '/api/approvals', { headers: bearer });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    });
  await withServer({ authStore: { async getSession() { throw Error('private auth data'); } } },
    async base => {
      const response = await fetch(base + '/api/approvals', { headers: bearer });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'AUTH_UNAVAILABLE' });
    });
});

function makeDraft(email, amount) {
  return { currency: 'CAD', customer: { name: 'Fictional customer', email, address: 'Synthetic address' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Private synthetic note',
    lines: [{ description: 'Synthetic service', quantity: 1, unitPriceCents: amount, taxable: false }], taxes: [] };
}

test('isolated PostgreSQL history is paginated, tenant-scoped and excludes customer contacts',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'ledger-' + crypto.randomUUID();
    const other = 'foreign-ledger-' + crypto.randomUUID();
    try {
      const owner = await createStaffAuthStore({ pool, businessId: tenant }).createPendingStaff({
        email: 'owner-' + crypto.randomUUID() + '@example.test', password: 'fictional-ledger-password-2026', role: 'OWNER',
      });
      const foreignOwner = await createStaffAuthStore({ pool, businessId: other }).createPendingStaff({
        email: 'foreign-' + crypto.randomUUID() + '@example.test', password: 'fictional-ledger-password-2026', role: 'OWNER',
      });
      const ownDrafts = createDraftStore({ pool, businessId: tenant });
      const a = await ownDrafts.createDraft(makeDraft('first@example.test', 1001), crypto.randomUUID().replace(/-/g, ''));
      const b = await ownDrafts.createDraft(makeDraft('second@example.test', 2002), crypto.randomUUID().replace(/-/g, ''));
      const foreignDraft = await createDraftStore({ pool, businessId: other }).createDraft(
        makeDraft('foreign@example.test', 9999), crypto.randomUUID().replace(/-/g, ''));
      for (const [businessId, draft, ownerId, approvedAt] of [
        [tenant, a, owner.id, '2026-09-20T14:00:00Z'],
        [tenant, b, owner.id, '2026-09-20T15:00:00Z'],
        [other, foreignDraft, foreignOwner.id, '2026-09-20T16:00:00Z'],
      ]) {
        await pool.query(
          `INSERT INTO facturations_draft_approvals(business_id,draft_id,approved_by,request_hash,approved_at)
           SELECT business_id,id,$3,request_hash,$4::timestamptz
             FROM invoice_drafts WHERE business_id=$1 AND id=$2`,
          [businessId, draft.id, ownerId, approvedAt]
        );
      }
      const ledger = createApprovalLedger({ pool, businessId: tenant });
      const first = await ledger.listApprovals(urlOptions('pageSize=1'));
      assert.equal(first.approvals.length, 1);
      assert.equal(first.hasMore, true);
      assert.equal(first.approvals[0].draftId, b.id);
      assert.equal(first.approvals[0].totalCents, '2002');
      assert.equal(first.approvals[0].status, 'APPROVED_INTERNAL_ONLY');
      assert.equal(first.approvals[0].issued, false);
      assert.equal(first.approvals[0].emailed, false);
      const second = await ledger.listApprovals(urlOptions('page=2&pageSize=1'));
      assert.equal(second.approvals[0].draftId, a.id);
      assert.equal(second.hasMore, false);
      const empty = await ledger.listApprovals(urlOptions('page=3&pageSize=1'));
      assert.deepEqual(empty.approvals, []);
      const raw = JSON.stringify([first, second]);
      for (const sensitive of ['first@example.test', 'second@example.test', 'foreign@example.test',
        'Synthetic address', 'Private synthetic note', '9999']) {
        assert.equal(raw.includes(sensitive), false, sensitive);
      }
      const foreignLedger = await createApprovalLedger({ pool, businessId: other }).listApprovals();
      assert.equal(foreignLedger.approvals.length, 1);
      assert.equal(foreignLedger.approvals[0].draftId, foreignDraft.id);
    } finally { await pool.end(); }
  });
