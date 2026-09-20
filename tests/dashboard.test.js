'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pageOptions, DashboardError, createDashboardStore } = require('../src/dashboard-store');
const { createServer } = require('../src/server');
const ADMIN = 's'.repeat(64);

async function withServer({ dashboardStore = null, draftStore = null, fetchImpl }, run) {
  const server = createServer({ config: { adminKey: ADMIN, waveToken: 'unused' }, dashboardStore, draftStore,
    fetchImpl: fetchImpl ?? (async () => { throw Error('Wave must not be called'); }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('pagination is bounded and rejects invalid forms', () => {
  assert.deepEqual(pageOptions(), { page: 1, pageSize: 20, offset: 0 });
  assert.deepEqual(pageOptions('1000', '50'), { page: 1000, pageSize: 50, offset: 49950 });
  for (const value of ['0', '-1', '1.1', '01', '1001', ' 2', 'abc']) {
    assert.throws(() => pageOptions(value, '20'), error => error instanceof DashboardError && error.code === 'INVALID_PAGE');
  }
  for (const value of ['0', '-1', '51', '001', '1.2', 'abc']) {
    assert.throws(() => pageOptions('1', value), error => error.code === 'INVALID_PAGE_SIZE');
  }
});

test('read-only store always applies business scope and does not return private customer contact data', async () => {
  const statements = [];
  const pool = { async query(sql, args) {
    statements.push({ sql, args });
    if (sql.includes('FROM invoice_drafts AS d')) return { rows: [{
      id: '11111111-1111-4111-8111-111111111111',
      created_at: new Date('2026-09-20T00:00:00Z'), invoice_date: '2026-09-20', due_date: '2026-10-20',
      total_cents: '2900', customer_name: 'Synthetic example', email: 'must-not-leak@example.test',
    }] };
    if (sql.includes('sum(')) return { rows: [{ draft_count: '1', draft_total_cents: '2900' }] };
    if (sql.includes('FROM invoice_customers')) return { rows: [{ customer_count: '1' }] };
    throw Error('Unexpected SQL');
  } };
  const store = createDashboardStore({ pool, businessId: 'business-example' });
  const list = await store.listDrafts(pageOptions('2', '5'));
  assert.equal(list.drafts.length, 1);
  assert.equal(list.drafts[0].totalCents, '2900');
  assert.equal(JSON.stringify(list).includes('must-not-leak'), false);
  assert.equal(list.status, 'DRAFTS_ONLY');
  const summary = await store.getSummary();
  assert.deepEqual(summary, { status: 'DRAFTS_ONLY', currency: 'CAD', draftCount: '1',
    draftTotalCents: '2900', customerCount: '1', issuedInvoicesAvailable: false,
    paymentsAvailable: false, revenueAvailable: false });
  assert.equal(statements.length, 3);
  for (const statement of statements) {
    assert.match(statement.sql, /business_id\s*=\s*\$1/);
    assert.equal(statement.args[0], 'business-example');
  }
  assert.deepEqual(statements[0].args, ['business-example', 5, 5]);
});

test('read APIs reject unauthorized, invalid queries, and unconfigured storage without Wave calls', async () => {
  let listCalls = 0;
  let summaryCalls = 0;
  let waveCalls = 0;
  const dashboardStore = {
    async listDrafts(opts) { listCalls++; return { status: 'DRAFTS_ONLY', ...opts, drafts: [] }; },
    async getSummary() { summaryCalls++; return { status: 'DRAFTS_ONLY', draftCount: '0' }; },
  };
  await withServer({ dashboardStore, fetchImpl: async () => { waveCalls++; throw Error('Wave must not be called'); } }, async base => {
    const unauthenticated = await fetch(base + '/api/dashboard/summary');
    assert.equal(unauthenticated.status, 401);
    const headers = { 'X-Admin-Key': ADMIN };
    for (const path of ['/api/drafts?page=0', '/api/drafts?page=1&page=2', '/api/drafts?pageSize=51', '/api/drafts?unused=1', '/api/dashboard/summary?extra=1']) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /^INVALID_/);
    }
    const list = await fetch(base + '/api/drafts?page=3&pageSize=4', { headers });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal((await list.json()).offset, 8);
    const summary = await fetch(base + '/api/dashboard/summary', { headers });
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).draftCount, '0');
    assert.equal((await fetch(base + '/api/dashboard/summary', { method: 'POST', headers })).status, 405);
    assert.equal(listCalls, 1);
    assert.equal(summaryCalls, 1);
    assert.equal(waveCalls, 0);
  });
  await withServer({}, async base => {
    const response = await fetch(base + '/api/dashboard/summary', { headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'STORAGE_NOT_CONFIGURED');
  });
});

test('dashboard database errors are sanitized and expose no SQL or connection credentials', async () => {
  await withServer({ dashboardStore: { async getSummary() { throw Error('DB password must not leak'); } } }, async base => {
    const response = await fetch(base + '/api/dashboard/summary', { headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
  });
});
