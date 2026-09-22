'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserCustomerContact } = require('../src/browser-customer-contact');

const ORIGIN = 'https://fictional.example.test';
const TOKEN = 'A'.repeat(43);
const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'fictional-contact-tenant';
const PATH = `/internal/customer-contact?lang=fr&id=${ID}`;
const fields = csrf => new URLSearchParams({ csrf, intent: 'SAVE_CONTACT_ONLY', revision: '1',
  name: 'Client fictif', email: 'client@example.test', address: 'Adresse fictive' }).toString();

async function fixture(run) {
  const state = { role: 'OWNER', active: true, tenant: TENANT, saves: [], reads: 0 };
  const auth = { async getSession(token) {
    return state.active && token === TOKEN ? { id: ID, role: state.role, businessId: state.tenant } : null;
  } };
  const store = { async getContact(id) {
    state.reads++;
    assert.equal(id, ID);
    return { id: ID, revision: 1, name: '<script> & Client', email: 'client@example.test', address: '<b>Rue</b>' };
  }, async saveContact(input) { state.saves.push(input); return { id: ID, revision: 2 }; } };
  const server = createServer({ config: { businessId: TENANT, adminKey: 'fictional-admin', waveToken: null } });
  attachBrowserCustomerContact(server, { origin: ORIGIN, businessId: TENANT,
    encryptionKeyHex: 'b'.repeat(64), staffAuthStore: auth, contactStore: store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function headers() { return { Cookie: `__Host-facturations-session=${TOKEN}` }; }
function post(base, path, body, overrides = {}) {
  const target = new URL(base + path);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port,
      path: target.pathname + target.search, method: 'POST', headers: {
        ...headers(), Host: 'fictional.example.test', Origin: ORIGIN,
        'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body), ...overrides,
      } }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode,
        location: response.headers.location, cookie: response.headers['set-cookie'] })); });
    request.on('error', reject); request.end(body);
  });
}

test('private customer form is escaped, bilingual, read-only on GET and OWNER-only', async () => {
  await fixture(async (base, state) => {
    assert.equal((await fetch(base + PATH)).status, 401);
    assert.equal((await fetch(base + PATH, { headers: { ...headers(), 'X-Admin-Key': 'fictional-admin' } })).status, 401);
    state.role = 'STAFF';
    assert.equal((await fetch(base + PATH, { headers: headers() })).status, 403);
    state.role = 'OWNER'; state.tenant = 'other-business';
    assert.equal((await fetch(base + PATH, { headers: headers() })).status, 401);
    state.tenant = TENANT;
    const page = await fetch(base + PATH, { headers: headers() });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    assert.equal(page.headers.get('set-cookie'), null);
    const html = await page.text();
    assert.match(html, /&lt;script&gt; &amp; Client/);
    assert.match(html, /&lt;b&gt;Rue&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /SAVE_CONTACT_ONLY/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
    assert.equal(state.saves.length, 0);
    const en = await fetch(base + PATH.replace('lang=fr', 'lang=en'), { headers: headers() });
    assert.match(await en.text(), /Correct customer details/);
  });
});

test('customer POST demands exact intent, origin, unique CSRF and redirects only after saving', async () => {
  await fixture(async (base, state) => {
    const html = await (await fetch(base + PATH, { headers: headers() })).text();
    const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
    assert.ok(csrf);
    assert.equal((await post(base, PATH, fields(csrf), { Origin: 'https://other.example.test' })).status, 403);
    assert.equal((await post(base, PATH, fields('X'.repeat(43)))).status, 403);
    assert.equal((await post(base, PATH, fields(csrf).replace('SAVE_CONTACT_ONLY', 'ISSUE_INVOICE'))).status, 422);
    assert.equal((await post(base, PATH, fields(csrf) + '&csrf=' + csrf)).status, 422);
    assert.equal(state.saves.length, 0);
    const accepted = await post(base, PATH, fields(csrf));
    assert.equal(accepted.status, 303);
    assert.equal(accepted.location, PATH);
    assert.equal(accepted.cookie, undefined);
    assert.equal(state.saves.length, 1);
    assert.equal(state.saves[0].sessionToken, TOKEN);
    assert.equal(state.saves[0].expectedRevision, 1);
    state.active = false;
    assert.equal((await post(base, PATH, fields(csrf))).status, 401);
    assert.equal(state.saves.length, 1);
  });
});
