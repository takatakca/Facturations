'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { createCustomerDirectory, customerListOptions } = require('../src/customer-directory');

const TOKEN = 'B'.repeat(43); // Fictional session fixture.
const ADMIN = 'k'.repeat(64); // Fictional server key fixture.
const BUSINESS = 'fictional-customer-business';
const UUID = '11111111-1111-4111-8111-111111111111';
const bearer = { Authorization: `Bearer ${TOKEN}` };
const options = query => customerListOptions(new URLSearchParams(query));

async function withServer({ role = 'OWNER', store, authStore } = {}, run) {
  const calls = { directory: 0, wave: 0 };
  const server = createServer({
    config: { businessId: BUSINESS, adminKey: ADMIN, waveToken: 'fictional-only' },
    staffAuthStore: authStore ?? { async getSession(token) {
      return token === TOKEN ? { id: UUID, role, businessId: BUSINESS } : null;
    } },
    customerDirectory: store ?? { async listCustomers(resultOptions) {
      calls.directory++;
      return { status: 'CUSTOMERS_ONLY', ...resultOptions, customers: [], hasMore: false };
    } },
    fetchImpl: async () => { calls.wave++; throw Error('Wave cannot be called'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('customer search bounds pagination, rejects duplicates and escapes literal wildcards', () => {
  assert.deepEqual(options(''), { page: 1, pageSize: 20, offset: 0, search: null });
  assert.deepEqual(options('page=2&pageSize=3&q=%20L%C3%A9a%20'),
    { page: 2, pageSize: 3, offset: 3, search: '%Léa%' });
  assert.equal(options('q=a%21%25_').search, '%a!!!%!_%');
  for (const query of ['page=0', 'pageSize=51', 'q=', 'q=x', 'q=%0Aab',
    'q=a&q=b', 'page=1&page=2', 'unknown=abc', 'q=' + 'a'.repeat(81)]) {
    assert.throws(() => options(query), error => error?.code?.startsWith('INVALID_'), query);
  }
});

test('customer contacts require OWNER; invalid and foreign sessions never fall back to admin key', async () => {
  await withServer({ role: 'STAFF' }, async (base, calls) => {
    const forbidden = await fetch(base + '/api/customers', { headers: bearer });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.directory, 0);
  });
  await withServer({}, async (base, calls) => {
    assert.equal((await fetch(base + '/api/customers')).status, 401);
    assert.equal((await fetch(base + '/api/customers',
      { headers: { Authorization: 'Bearer invalid', 'X-Admin-Key': ADMIN } })).status, 401);
    const response = await fetch(base + '/api/customers?page=2&pageSize=5&q=example', { headers: bearer });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).search, '%example%');
    assert.equal((await fetch(base + '/api/customers', { headers: { 'X-Admin-Key': ADMIN } })).status, 200);
    for (const query of ['?q=', '?page=0', '?page=1&page=2', '?extra=1']) {
      assert.equal((await fetch(base + '/api/customers' + query, { headers: bearer })).status, 422, query);
    }
    assert.equal((await fetch(base + '/api/customers', { method: 'POST', headers: bearer })).status, 405);
    assert.equal(calls.directory, 2);
    assert.equal(calls.wave, 0);
  });
  await withServer({ authStore: { async getSession() {
    return { id: UUID, role: 'OWNER', businessId: 'another-business' };
  } } }, async (base, calls) => {
    assert.equal((await fetch(base + '/api/customers', { headers: bearer })).status, 401);
    assert.equal(calls.directory, 0);
  });
});

test('customer directory sanitizes database errors', async () => {
  await withServer({ store: { async listCustomers() { throw Error('private email database secret'); } } },
    async base => {
      const response = await fetch(base + '/api/customers', { headers: bearer });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    });
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('isolated PostgreSQL: customer search, ordered pagination and cross-business denial',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'directory-' + crypto.randomUUID();
    const other = 'directory-' + crypto.randomUUID();
    const suffix = crypto.randomUUID().slice(0, 8);
    const store = createCustomerDirectory({ pool, businessId: tenant });
    try {
      for (const [businessId, name, email] of [
        [tenant, 'Alpha %', `alpha-${suffix}@example.test`],
        [tenant, 'Beta One', `beta-${suffix}@example.test`],
        [tenant, 'Charlie', `charlie-${suffix}@example.test`],
        [other, 'Foreign %', `foreign-${suffix}@example.test`],
      ]) {
        await pool.query('INSERT INTO invoice_customers(business_id,name,email,email_normalized) VALUES ($1,$2,$3,$3)',
          [businessId, name, email]);
      }
      const first = await store.listCustomers(options('pageSize=2'));
      assert.deepEqual(first.customers.map(c => c.name), ['Alpha %', 'Beta One']);
      assert.equal(first.hasMore, true);
      assert.ok(first.customers.every(c => c.email.endsWith('@example.test')));
      const second = await store.listCustomers(options('page=2&pageSize=2'));
      assert.deepEqual(second.customers.map(c => c.name), ['Charlie']);
      assert.equal(second.hasMore, false);
      const literal = await store.listCustomers(options('q=a%20%25'));
      assert.deepEqual(literal.customers.map(c => c.name), ['Alpha %']);
      const emails = await store.listCustomers(options(`q=${suffix}`));
      assert.equal(emails.customers.length, 3);
      assert.ok(emails.customers.every(c => !c.name.startsWith('Foreign')));
    } finally {
      await pool.query('DELETE FROM invoice_customers WHERE business_id=ANY($1::text[])', [[tenant, other]]);
      await pool.end();
    }
  });
