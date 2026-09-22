'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserCustomerDirectory, renderCustomerDirectory } = require('../src/browser-customer-directory');
const { createCustomerDirectory } = require('../src/customer-directory');
const { renderDashboard } = require('../src/dashboard-view');

const ORIGIN = 'https://fictional.example.test';
const BUSINESS = 'directory-fixture';
const TOKEN = 'D'.repeat(43);
const UUID = '11111111-1111-4111-8111-111111111111';
const cookie = token => ({ Cookie: '__Host-facturations-session=' + token });
const customer = { name: 'Fictional <script> & Société', email: 'client@example.test', address: '123 <nowhere>' };
const sample = options => ({ status: 'CUSTOMERS_ONLY', page: options.page, pageSize: 20,
  hasMore: false, customers: [{ ...customer }] });
async function withServer({ role = 'OWNER', businessId = BUSINESS, listCustomers = sample } = {}, run) {
  const calls = [];
  const server = createServer({ config: { businessId: BUSINESS, adminKey: 'k'.repeat(64), waveToken: null } });
  attachBrowserCustomerDirectory(server, { origin: ORIGIN, businessId: BUSINESS,
    staffAuthStore: { async getSession(token) {
      return token === TOKEN ? { id: UUID, role, businessId } : null;
    } },
    customerDirectory: { async listCustomers(options) { calls.push(options); return listCustomers(options); } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function rawPost(base, path, body, headers = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST', headers: { ...cookie(TOKEN), Host: 'fictional.example.test', Origin: ORIGIN,
        'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded',
        ...headers, 'Content-Length': Buffer.byteLength(body) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('owner navigation is bilingual and never exposed by STAFF dashboard', () => {
  const summary = { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '1', draftTotalCents: '0' };
  const drafts = { status: 'DRAFTS_ONLY', drafts: [] };
  for (const language of ['fr', 'en']) {
    const owner = renderDashboard({ summary, drafts, language, ownerReview: true });
    const staff = renderDashboard({ summary, drafts, language, ownerReview: false });
    assert.match(owner, new RegExp(`/internal/customers\\?lang=${language}`));
    assert.doesNotMatch(staff, /internal\/customers/);
  }
});

test('private FR/EN page escapes customer details, bounds pagination and searches without names in URLs', async () => {
  await withServer({}, async (base, calls) => {
    for (const lang of ['fr', 'en']) {
      const response = await fetch(base + `/internal/customers?lang=${lang}`, { headers: cookie(TOKEN) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
      const html = await response.text();
      assert.match(html, new RegExp(`<html lang="${lang}"`));
      assert.match(html, /Fictional &lt;script&gt; &amp; Société/);
      assert.match(html, /123 &lt;nowhere&gt;/);
      assert.doesNotMatch(html, /<script>/);
      assert.doesNotMatch(html, /href="[^"]*client@example\.test/);
      assert.doesNotMatch(html, new RegExp(TOKEN));
    }
    assert.equal((await fetch(base + '/internal/customers?lang=fr&page=2',
      { headers: cookie(TOKEN) })).status, 200);
    assert.equal(calls.at(-1).offset, 20);
    const search = await rawPost(base, '/internal/customers?lang=fr', 'q=' + encodeURIComponent('  Société  '));
    assert.equal(search.status, 200);
    assert.match(search.body, /value="Société"/);
    assert.match(search.body, /method="post" action="\/internal\/customers\?lang=fr"/);
    assert.deepEqual(calls.at(-1), { page: 1, pageSize: 20, offset: 0, search: '%Société%' });
    const literal = await rawPost(base, '/internal/customers?lang=en', 'q=a%25_');
    assert.equal(literal.status, 200);
    assert.equal(calls.at(-1).search, '%a!% break%'.replace(' break%', '!_%'));
  });
});

test('unauthenticated, STAFF, foreign tenant, revoked and bearer/admin requests expose no contacts', async () => {
  for (const config of [{}, { role: 'STAFF' }, { businessId: 'another-tenant' }]) {
    await withServer(config, async (base, calls) => {
      assert.equal((await fetch(base + '/internal/customers')).status, 401);
      assert.equal((await fetch(base + '/internal/customers', { headers: cookie('Z'.repeat(43)) })).status, 401);
      assert.equal((await fetch(base + '/internal/customers',
        { headers: { ...cookie(TOKEN), Authorization: 'Bearer ' + TOKEN } })).status, 401);
      assert.equal((await fetch(base + '/internal/customers',
        { headers: { ...cookie(TOKEN), 'X-Admin-Key': 'k'.repeat(64) } })).status, 401);
      const own = await fetch(base + '/internal/customers', { headers: cookie(TOKEN) });
      assert.equal(own.status, config.role === 'STAFF' ? 403 : config.businessId ? 401 : 200);
      assert.equal(calls.length, config.role || config.businessId ? 0 : 1);
    });
  }
});

test('invalid methods, duplicate query, cross-origin, malformed body and unsupported content type fail closed', async () => {
  await withServer({}, async (base, calls) => {
    for (const path of ['?lang=es', '?lang=en&lang=fr', '?q=private', '?page=0', '?page=10000',
      '?page=1&page=2']) {
      assert.equal((await fetch(base + '/internal/customers' + path, { headers: cookie(TOKEN) })).status, 422);
    }
    assert.equal((await fetch(base + '/internal/customers',
      { method: 'PUT', headers: cookie(TOKEN) })).status, 405);
    for (const [body, headers, status] of [
      ['q=abc', { Origin: 'https://other.example.test' }, 403],
      ['q=abc', { Host: 'other.example.test' }, 403],
      ['q=abc', { 'Content-Type': 'application/json' }, 415],
      ['q=a', {}, 422], ['q=abc&q=xyz', {}, 422], ['q=ab%0Acd', {}, 422],
    ]) {
      assert.equal((await rawPost(base, '/internal/customers?lang=en', body, headers)).status, status);
    }
    assert.equal((await rawPost(base, '/internal/customers?lang=en&page=2', 'q=abc')).status, 422);
    assert.equal(calls.length, 0);
  });
  assert.throws(() => attachBrowserCustomerDirectory({ listeners: () => [] }, {}), TypeError);
  assert.throws(() => renderCustomerDirectory({ status: 'CUSTOMERS_ONLY', page: 1, pageSize: 20,
    hasMore: false, customers: new Array(21).fill(customer) }), TypeError);
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL: owner-only listing and literal search are scoped to business', { skip: !DATABASE }, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const tenant = 'customer-browser-' + crypto.randomUUID();
  const other = 'customer-browser-' + crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  try {
    await pool.query('INSERT INTO invoice_customers(business_id,name,email,email_normalized) VALUES($1,$2,$3,$3)',
      [tenant, 'Named % client', `client-${suffix}@example.test`]);
    await pool.query('INSERT INTO invoice_customers(business_id,name,email,email_normalized) VALUES($1,$2,$3,$3)',
      [other, 'Foreign % client', `foreign-${suffix}@example.test`]);
    const directory = createCustomerDirectory({ pool, businessId: tenant });
    await withServer({ listCustomers: options => directory.listCustomers(options) }, async base => {
      const response = await fetch(base + '/internal/customers?lang=en', { headers: cookie(TOKEN) });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Named % client/);
      assert.doesNotMatch(html, /Foreign % client/);
      const search = await rawPost(base, '/internal/customers?lang=fr', 'q=Named+%25');
      assert.equal(search.status, 200);
      assert.match(search.body, /Named % client/);
      assert.doesNotMatch(search.body, /Foreign % client/);
    });
  } finally {
    await pool.query('DELETE FROM invoice_customers WHERE business_id=ANY($1::text[])', [[tenant, other]]);
    await pool.end();
  }
});
