'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { resolveReadOnlyStaff } = require('../src/staff-read-access');

const TOKEN = 'A'.repeat(43); // Synthetic test fixture, not a credential.
const ADMIN = 'k'.repeat(64); // Synthetic test fixture, never a production key.
const TENANT = 'fictional-tenant';
const STAFF = { id: '11111111-1111-4111-8111-111111111111', businessId: TENANT, role: 'STAFF' };
const DRAFT = '22222222-2222-4222-8222-222222222222';

async function withServer({ staffAuthStore, businessId = TENANT, adminKey = ADMIN } = {}, run) {
  const calls = { summary: 0, list: 0, detail: 0, write: 0, wave: 0 };
  const server = createServer({
    config: { businessId, adminKey, waveToken: 'fictional-token' },
    staffAuthStore,
    dashboardStore: {
      async getSummary() { calls.summary++; return { status: 'DRAFTS_ONLY', draftCount: '0' }; },
      async listDrafts() { calls.list++; return { status: 'DRAFTS_ONLY', drafts: [] }; },
    },
    draftStore: {
      async getDraft(id) { calls.detail++; return { id, status: 'DRAFT' }; },
      async createDraft() { calls.write++; throw Error('Write must not be called'); },
    },
    fetchImpl: async () => { calls.wave++; throw Error('Wave must not be called'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

async function read(base, path, headers = bearer, options = {}) {
  const response = await fetch(base + path, { headers, ...options });
  return { response, body: await response.json() };
}

test('read guard validates exact bearer format, business identity and staff role', async () => {
  let calls = 0;
  const store = { async getSession(token) { calls++; assert.equal(token, TOKEN); return STAFF; } };
  assert.deepEqual(await resolveReadOnlyStaff({ authorization: `Bearer ${TOKEN}`, store, businessId: TENANT }), STAFF);
  assert.equal(await resolveReadOnlyStaff({ authorization: TOKEN, store, businessId: TENANT }), null);
  assert.equal(await resolveReadOnlyStaff({ authorization: `Bearer ${TOKEN} extra`, store, businessId: TENANT }), null);
  assert.equal(await resolveReadOnlyStaff({ authorization: `Bearer ${TOKEN}`, store, businessId: 'other-business' }), null);
  assert.equal(await resolveReadOnlyStaff({ authorization: `Bearer ${TOKEN}`, store: null, businessId: TENANT }), null);
  assert.equal(calls, 2);
  for (const role of ['CUSTOMER', 'ADMIN', null]) {
    assert.equal(await resolveReadOnlyStaff({ authorization: `Bearer ${TOKEN}`,
      store: { async getSession() { return { ...STAFF, role }; } }, businessId: TENANT }), null);
  }
});

test('valid staff session reads only dashboard and saved drafts, not Wave or writes', async () => {
  const store = { async getSession(token) { return token === TOKEN ? STAFF : null; } };
  await withServer({ staffAuthStore: store }, async (base, calls) => {
    for (const route of ['/api/dashboard/summary', '/api/drafts?page=1&pageSize=2', `/api/drafts/${DRAFT}`]) {
      const { response } = await read(base, route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const [route, method] of [
      ['/api/wave/businesses', 'GET'],
      ['/api/drafts/preview', 'POST'],
      ['/api/drafts', 'POST'],
    ]) {
      const { response, body } = await read(base, route, bearer, { method });
      assert.equal(response.status, 403, route);
      assert.deepEqual(body, { error: 'STAFF_READ_ONLY' });
    }
    assert.deepEqual(calls, { summary: 1, list: 1, detail: 1, write: 0, wave: 0 });
  });
});

test('invalid, revoked and cross-tenant sessions fail closed with no admin-key fallback', async () => {
  const store = { async getSession() { return null; } };
  await withServer({ staffAuthStore: store }, async (base, calls) => {
    for (const headers of [
      bearer,
      { ...bearer, 'X-Admin-Key': ADMIN },
      { Authorization: 'Bearer invalid', 'X-Admin-Key': ADMIN },
    ]) {
      const { response, body } = await read(base, '/api/dashboard/summary', headers);
      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: 'UNAUTHORIZED' });
    }
    assert.equal(calls.summary, 0);
    const admin = await read(base, '/api/dashboard/summary', { 'X-Admin-Key': ADMIN });
    assert.equal(admin.response.status, 200); // Legacy server-to-server calls remain compatible.
    assert.equal(calls.summary, 1);
  });
  await withServer({ staffAuthStore: { async getSession() { return STAFF; } }, businessId: 'other-business' },
    async (base, calls) => {
      assert.equal((await read(base, '/api/dashboard/summary')).response.status, 401);
      assert.equal(calls.summary, 0);
    });
});

test('missing staff store and unexpected auth storage error never expose internals', async () => {
  await withServer({}, async (base, calls) => {
    assert.equal((await read(base, '/api/dashboard/summary')).response.status, 401);
    assert.equal(calls.summary, 0);
  });
  await withServer({ staffAuthStore: { async getSession() { throw Error('private SQL credential and data'); } } },
    async (base, calls) => {
      const { response, body } = await read(base, '/api/dashboard/summary');
      assert.equal(response.status, 503);
      assert.deepEqual(body, { error: 'AUTH_UNAVAILABLE' });
      assert.equal(calls.summary, 0);
    });
});
