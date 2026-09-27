'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const {
  attachBrowserIssuanceAuthorization,
} = require('../src/browser-owner-issuance-authorization');
const { previewDraft } = require('../src/draft-preview');

const ORIGIN = 'https://fictional.example.test';
const TENANT = 'issuance-route-fixture';
const TOKEN = 'I'.repeat(43);
const KEY = 'c'.repeat(64);
const OWNER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'recipient@example.test';
const PATH = `/internal/review/${ID}/authorize-issuance?lang=fr`;

function draft() {
  const preview = previewDraft({
    currency: 'CAD',
    customer: { name: 'Fictional recipient', email: EMAIL, address: 'Example only' },
    invoiceDate: '2026-09-22',
    dueDate: '2026-10-22',
    notes: 'Synthetic only',
    lines: [{ description: 'Example service', quantity: 1, unitPriceCents: 2500, taxable: false }],
    taxes: [],
  });
  return { id: ID, status: 'DRAFT', preview: { ...preview, status: 'DRAFT', persisted: true } };
}

function fake() {
  const state = {
    role: 'OWNER',
    approved: true,
    revoked: false,
    authorization: null,
    writes: 0,
    captured: null,
  };
  return {
    state,
    staffAuthStore: {
      async getSession(token) {
        return token === TOKEN && !state.revoked
          ? { id: OWNER, businessId: TENANT, role: state.role } : null;
      },
    },
    draftStore: {
      async getDraft(id) {
        assert.equal(id, ID);
        return draft();
      },
    },
    approvalStore: {
      async isApproved() { return state.approved; },
    },
    authorizationStore: {
      async getAuthorization() { return state.authorization; },
      async authorize(command) {
        state.writes++;
        state.captured = command;
        state.authorization = {
          id: '33333333-3333-4333-8333-333333333333',
          draftId: ID,
          status: 'AUTHORIZED_PENDING_PROVIDER',
          provider: 'WAVE',
          issued: false,
          waveSynced: false,
          emailed: false,
        };
        return state.authorization;
      },
    },
  };
}

async function withServer(stores, run) {
  const server = createServer({
    config: { businessId: TENANT, adminKey: 'synthetic-private-admin', waveToken: null },
  });
  attachBrowserIssuanceAuthorization(server, {
    origin: ORIGIN,
    businessId: TENANT,
    encryptionKeyHex: KEY,
    staffAuthStore: stores.staffAuthStore,
    draftStore: stores.draftStore,
    approvalStore: stores.approvalStore,
    authorizationStore: stores.authorizationStore,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function headers(token = TOKEN) {
  return { Cookie: `__Host-facturations-session=${token}` };
}
function postHeaders(token = TOKEN) {
  return {
    ...headers(token),
    Host: 'fictional.example.test',
    Origin: ORIGIN,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}
function csrfFrom(html) {
  const match = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html);
  assert.ok(match, 'CSRF token required');
  return match[1];
}
function form(csrf, overrides = {}) {
  return new URLSearchParams({
    csrf,
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    provider: 'WAVE',
    expectedTotalCents: '2500',
    expectedCustomerEmail: EMAIL,
    reviewed: 'yes',
    ...overrides,
  }).toString();
}
function rawPost(base, body, extraHeaders = postHeaders()) {
  const url = new URL(base + PATH);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...extraHeaders, 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('issuance route is OWNER-only and requires a prior internal approval', async () => {
  const stores = fake();
  await withServer(stores, async base => {
    assert.equal((await fetch(base + PATH)).status, 401);
    stores.state.role = 'STAFF';
    assert.equal((await fetch(base + PATH, { headers: headers() })).status, 403);
    stores.state.role = 'OWNER';
    stores.state.approved = false;
    assert.equal((await fetch(base + PATH, { headers: headers() })).status, 409);
    stores.state.approved = true;
    assert.equal((await fetch(base + PATH + '&token=secret', { headers: headers() })).status, 422);
    stores.state.revoked = true;
    assert.equal((await fetch(base + PATH, { headers: headers() })).status, 401);
    assert.equal(stores.state.writes, 0);
  });
});

test('GET clearly remains unissued and POST requires exact CSRF, origin and confirmation', async () => {
  const stores = fake();
  await withServer(stores, async base => {
    const response = await fetch(base + PATH, { headers: headers() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const html = await response.text();
    assert.match(html, /n’émet pas la facture/);
    assert.match(html, /AUTHORIZE_ISSUANCE_PENDING_PROVIDER/);
    assert.match(html, /name="provider" value="WAVE"/);
    assert.match(html, /name="expectedTotalCents" value="2500"/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
    const csrf = csrfFrom(html);

    assert.equal((await rawPost(base, form('X'.repeat(43)))).status, 403);
    assert.equal((await rawPost(base, form(csrf), {
      ...postHeaders(), Origin: 'https://other.example.test',
    })).status, 403);
    assert.equal((await rawPost(base, form(csrf, { confirmation: 'ISSUE_NOW' }))).status, 422);
    assert.equal((await rawPost(base, form(csrf, { provider: 'OTHER' }))).status, 422);
    assert.equal((await rawPost(base, form(csrf, { reviewed: 'no' }))).status, 422);
    assert.equal(stores.state.writes, 0);

    const accepted = await rawPost(base, form(csrf));
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.location, PATH);
    assert.equal(stores.state.writes, 1);
    assert.deepEqual(stores.state.captured, {
      confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      draftId: ID,
      ownerId: OWNER,
      sessionToken: TOKEN,
      expectedTotalCents: 2500,
      expectedCustomerEmail: EMAIL,
      provider: 'WAVE',
    });

    const status = await fetch(base + PATH, { headers: headers() });
    assert.equal(status.status, 200);
    const statusHtml = await status.text();
    assert.match(statusHtml, /EN ATTENTE/);
    assert.match(statusHtml, /NON/);
    assert.match(statusHtml, /facture demeure non émise/);
    assert.doesNotMatch(statusHtml, /AUTHORIZE_ISSUANCE_PENDING_PROVIDER/);
  });
});

test('route construction fails closed without dedicated issuance dependencies', () => {
  assert.throws(() => attachBrowserIssuanceAuthorization({ listeners: () => [] }, {}), /Dedicated/);
});
