'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createDraftStore, StoreError } = require('../src/draft-store');
const { createServer } = require('../src/server');

const BUSINESS = 'wave-business-example';
const OTHER = 'other-wave-business';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const KEY = 'request_1234567890123456789';
const ADMIN = 'x'.repeat(64);
function valid() {
  return { currency: 'CAD', customer: { name: 'Fictional Customer', email: 'fictional@example.test' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: null,
    lines: [{ description: 'Sample work', quantity: 2, unitPriceCents: 1500, taxable: false }], taxes: [] };
}

function fakePool() {
  const customers = new Map();
  const drafts = new Map();
  const audit = [];
  const calls = [];
  let releases = 0;
  async function query(sql, args = []) {
    calls.push({ sql, args });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('INSERT INTO invoice_customers')) {
      const key = args[0] + ':' + args[3];
      if (!customers.has(key)) customers.set(key, CUSTOMER);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM invoice_customers')) {
      const id = customers.get(args[0] + ':' + args[1]);
      return { rows: id ? [{ id }] : [] };
    }
    if (sql.startsWith('INSERT INTO invoice_drafts')) {
      const key = args[0] + ':' + args[2];
      if (drafts.has(key)) return { rows: [] };
      const row = { id: DRAFT, business_id: args[0], request_hash: args[3],
        snapshot: JSON.parse(args[4]), created_at: new Date('2026-09-20T00:00:00Z') };
      drafts.set(key, row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT id, request_hash, snapshot')) {
      const row = drafts.get(args[0] + ':' + args[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('SELECT id, snapshot')) {
      const row = [...drafts.values()].find(d => d.business_id === args[0] && d.id === args[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('INSERT INTO invoice_audit_events')) {
      audit.push(args);
      return { rows: [] };
    }
    throw new Error('Unexpected SQL statement');
  }
  const pool = { query, async connect() { return { query, release() { releases++; } }; } };
  return { pool, audit, calls, drafts, get releases() { return releases; } };
}

test('saves a normalized draft with one customer and one audit event', async () => {
  const db = fakePool();
  const store = createDraftStore({ pool: db.pool, businessId: BUSINESS });
  const saved = await store.createDraft(valid(), KEY);
  assert.equal(saved.id, DRAFT);
  assert.equal(saved.status, 'DRAFT');
  assert.equal(saved.preview.persisted, true);
  assert.equal(saved.preview.totalCents, 3000);
  assert.equal(saved.waveSynced, false);
  assert.equal(saved.emailed, false);
  assert.equal(db.audit.length, 1);
  assert.equal(db.releases, 1);
  assert.equal((await store.getDraft(DRAFT)).id, DRAFT);
  assert.ok(db.calls.some(x => x.sql === 'COMMIT'));
  assert.ok(db.calls.every(x => !JSON.stringify(x.args).includes('real-access-token')));
});

test('same idempotency key and same payload returns original without duplicate audit', async () => {
  const db = fakePool(); const store = createDraftStore({ pool: db.pool, businessId: BUSINESS });
  const first = await store.createDraft(valid(), KEY);
  const repeated = await store.createDraft(valid(), KEY);
  assert.deepEqual(repeated, first);
  assert.equal(db.audit.length, 1);
  assert.equal(db.drafts.size, 1);
  assert.equal(db.releases, 2);
});

test('same key with different amount conflicts and rolls back', async () => {
  const db = fakePool(); const store = createDraftStore({ pool: db.pool, businessId: BUSINESS });
  await store.createDraft(valid(), KEY);
  const modified = valid(); modified.lines[0].unitPriceCents = 700;
  await assert.rejects(store.createDraft(modified, KEY), e => e instanceof StoreError && e.code === 'IDEMPOTENCY_CONFLICT' && e.statusCode === 409);
  assert.equal(db.audit.length, 1);
  assert.ok(db.calls.some(x => x.sql === 'ROLLBACK'));
});

test('tenant scope prevents looking up drafts belonging to other businesses', async () => {
  const db = fakePool();
  await createDraftStore({ pool: db.pool, businessId: BUSINESS }).createDraft(valid(), KEY);
  const other = createDraftStore({ pool: db.pool, businessId: OTHER });
  await assert.rejects(other.getDraft(DRAFT), e => e instanceof StoreError && e.code === 'DRAFT_NOT_FOUND');
});

test('invalid IDs and keys rejected before querying the database', async () => {
  const db = fakePool(); const store = createDraftStore({ pool: db.pool, businessId: BUSINESS });
  await assert.rejects(store.getDraft('not-a-uuid'), e => e.code === 'INVALID_DRAFT_ID');
  await assert.rejects(store.createDraft(valid(), 'short'), e => e.code === 'INVALID_IDEMPOTENCY_KEY');
  assert.equal(db.calls.length, 0);
});

test('draft persistence route requires admin key and fails closed without database', async () => {
  const server = createServer({ config: { adminKey: ADMIN, waveToken: '' } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(url + '/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid()) });
    assert.equal(denied.status, 401);
    const unavailable = await fetch(url + '/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN, 'Idempotency-Key': KEY }, body: JSON.stringify(valid()) });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error, 'STORAGE_NOT_CONFIGURED');
    const get = await fetch(url + '/api/drafts/' + DRAFT, { headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(get.status, 503);
    assert.equal((await get.json()).error, 'STORAGE_NOT_CONFIGURED');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('configured draft API validates key and retrieves saved data without contacting Wave', async () => {
  const db = fakePool(); const store = createDraftStore({ pool: db.pool, businessId: BUSINESS });
  let waveCalls = 0;
  const server = createServer({ config: { adminKey: ADMIN, waveToken: 'not-used' }, draftStore: store,
    fetchImpl: async () => { waveCalls++; throw Error('Must not call Wave'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN, 'Idempotency-Key': KEY };
    const missing = await fetch(url + '/api/drafts', { method: 'POST', headers: { ...headers, 'Idempotency-Key': '' }, body: JSON.stringify(valid()) });
    assert.equal(missing.status, 422);
    const created = await fetch(url + '/api/drafts', { method: 'POST', headers, body: JSON.stringify(valid()) });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).id, DRAFT);
    const retrieved = await fetch(url + '/api/drafts/' + DRAFT, { headers: { 'X-Admin-Key': ADMIN } });
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.json()).preview.totalCents, 3000);
    assert.equal(waveCalls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
