'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserWorkspaceSubmission } = require('../src/browser-workspace-submission');
const { renderWorkspacePreview } = require('../src/browser-workspace-preview');
const { previewDraft } = require('../src/draft-preview');

const ORIGIN = 'https://fictional.example.test';
const BUSINESS = 'fictional-submission';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'S'.repeat(43);
const KEY = 'e'.repeat(64);
const PATH = `/internal/submit/${WORKSPACE_ID}?lang=fr`;
function data() { return { currency: 'CAD',
  customer: { name: '<Client> & Co', email: 'fictional@example.test', address: 'Fictional address' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Only <example> & fake',
  lines: [{ description: '<Service>', quantity: 2, unitPriceCents: 1250,
    discountCents: 0, taxable: false }], taxes: [] }; }
function fixture() {
  const state = { role: 'OWNER', revoked: false, calls: 0, submission: null, revision: 1, incomplete: false };
  const staffAuthStore = { async getSession(token) {
    return token === TOKEN && !state.revoked
      ? { id: OWNER_ID, businessId: BUSINESS, role: state.role } : null;
  } };
  const workspaceStore = { async load({ token, workspaceId }) {
    state.calls++;
    if (token !== TOKEN || workspaceId !== WORKSPACE_ID) throw Error('private fake store');
    return { id: WORKSPACE_ID, revision: state.revision,
      content: state.incomplete ? { currency: 'CAD', customer: {} } : data(),
      status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
  } };
  const submissionStore = { async submit(command) { state.submission = command;
    return { draftId: DRAFT_ID, status: 'DRAFT', issued: false, emailed: false, waveSynced: false };
  } };
  return { state, staffAuthStore, workspaceStore, submissionStore };
}
async function withServer(stores, run) {
  const server = createServer({ config: { businessId: BUSINESS,
    adminKey: 'fictional-private-admin', waveToken: null } });
  attachBrowserWorkspaceSubmission(server, { origin: ORIGIN, encryptionKeyHex: KEY,
    businessId: BUSINESS, ...stores });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function cookie(token = TOKEN) { return { Cookie: `__Host-facturations-session=${token}` }; }
function postHeaders(token = TOKEN) { return { ...cookie(token), Host: 'fictional.example.test',
  Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }; }
function body(csrf, changes = {}) { return new URLSearchParams({ csrf, confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY',
  expectedRevision: '1', expectedTotalCents: '2500', expectedCustomerEmail: 'fictional@example.test',
  reviewed: 'yes', ...changes }).toString(); }
function rawPost(base, path, content, headers = postHeaders()) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, method: 'POST',
      path: url.pathname + url.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(content) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(content);
  });
}
function csrfFrom(html) {
  const match = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html);
  assert.ok(match);
  return match[1];
}

test('FR/EN preview exposes preparation link only when owner authorization is enabled', () => {
  const p = previewDraft(data());
  for (const lang of ['fr', 'en']) {
    const row = { preview: p, id: WORKSPACE_ID, revision: 1, language: lang };
    const staff = renderWorkspacePreview(row);
    const owner = renderWorkspacePreview({ ...row, ownerSubmission: true });
    assert.doesNotMatch(staff, /\/internal\/submit\//);
    assert.match(owner, new RegExp(`/internal/submit/${WORKSPACE_ID}\\?lang=${lang}`));
    assert.doesNotMatch(owner, new RegExp(TOKEN));
  }
});

test('owner sees exact saved preview and only an explicit, unchecked submission form', async () => {
  const stores = fixture();
  await withServer(stores, async base => {
    for (const lang of ['fr', 'en']) {
      const response = await fetch(base + PATH.replace('lang=fr', `lang=${lang}`), { headers: cookie() });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
      const html = await response.text();
      assert.match(html, /&lt;Client&gt; &amp; Co/);
      assert.match(html, /Only &lt;example&gt; &amp; fake/);
      assert.match(html, /CREATE_IMMUTABLE_DRAFT_ONLY/);
      assert.match(html, /name="expectedRevision" value="1"/);
      assert.match(html, /name="expectedTotalCents" value="2500"/);
      assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
      assert.doesNotMatch(html, /<script>/);
      assert.doesNotMatch(html, new RegExp(TOKEN));
    }
    assert.equal(stores.state.submission, null);
    stores.state.incomplete = true;
    const incomplete = await fetch(base + PATH, { headers: cookie() });
    assert.equal(incomplete.status, 422);
    assert.doesNotMatch(await incomplete.text(), /<form\b/);
  });
});

test('POST denies missing credentials, staff, wrong origin/Host, missing CSRF, duplicate fields and stale revision', async () => {
  const stores = fixture();
  await withServer(stores, async base => {
    assert.equal((await fetch(base + PATH)).status, 401);
    assert.equal((await fetch(base + PATH, { headers: { ...cookie(), Authorization: 'Bearer ' + TOKEN } })).status, 401);
    assert.equal((await fetch(base + PATH, { headers: { ...cookie(), 'X-Admin-Key': 'fictional-private-admin' } })).status, 401);
    stores.state.role = 'STAFF';
    assert.equal((await fetch(base + PATH, { headers: cookie() })).status, 403);
    stores.state.role = 'OWNER';
    const csrf = csrfFrom(await (await fetch(base + PATH, { headers: cookie() })).text());
    assert.equal((await rawPost(base, PATH, body(csrf), { ...postHeaders(), Origin: 'https://evil.example.test' })).status, 403);
    assert.equal((await rawPost(base, PATH, body(csrf), { ...postHeaders(), Host: 'evil.example.test' })).status, 403);
    assert.equal((await rawPost(base, PATH, body(csrf), { ...postHeaders(), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await rawPost(base, PATH, body('X'.repeat(43)))).status, 403);
    assert.equal((await rawPost(base, PATH, body(csrf, { reviewed: 'no' }))).status, 422);
    assert.equal((await rawPost(base, PATH, body(csrf, { confirmation: 'ISSUE_NOW' }))).status, 422);
    assert.equal((await rawPost(base, PATH, body(csrf) + '&csrf=' + csrf)).status, 422);
    assert.equal((await rawPost(base, PATH, body(csrf), { ...postHeaders(), 'Content-Type': 'application/json' })).status, 415);
    stores.state.revision = 2;
    assert.equal((await rawPost(base, PATH, body(csrf))).status, 409);
    stores.state.revision = 1;
    assert.equal(stores.state.submission, null);
    const accepted = await rawPost(base, PATH, body(csrf));
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.location, `/internal/review/${DRAFT_ID}?lang=fr`);
    assert.equal(accepted.headers['cache-control'], 'private, no-store');
    assert.deepEqual(stores.state.submission, { confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY',
      workspaceId: WORKSPACE_ID, sessionToken: TOKEN, expectedRevision: 1,
      expectedTotalCents: 2500, expectedCustomerEmail: 'fictional@example.test' });
    stores.state.revoked = true;
    assert.equal((await rawPost(base, PATH, body(csrf))).status, 401);
  });
});
