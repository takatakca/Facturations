'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');
const { createRecentWorkspaceStore } = require('../src/recent-workspace-store');
const { attachBrowserRecentWorkspaces, renderRecentWorkspaces } = require('../src/browser-recent-workspaces');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'A'.repeat(43);
const ID = '11111111-1111-4111-8111-111111111111';
const row = { id: ID, revision: 1, updatedAt: '2026-09-21T01:00:00.000Z', customerName: 'Fictional & <client>' };
const listing = { status: 'WORKSPACES_ONLY', workspaces: [row] };
const ORIGIN = 'https://fictional.example.test';

async function withServer(store, run) {
  const server = createServer({ config: { businessId: 'fictional-name-search', adminKey: 'synthetic-admin', waveToken: null } });
  attachBrowserRecentWorkspaces(server, { origin: ORIGIN, recentStore: store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function postForm(base, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({ hostname: url.hostname, port: url.port,
      path: '/internal/recent-workspaces?lang=fr', method: 'POST', headers: {
        Host: 'fictional.example.test', Origin: ORIGIN,
        Cookie: `${COOKIE_NAME}=${TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body), ...headers,
      } }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('FR/EN search forms are private POSTs, escaped, and never add client data to URLs', () => {
  for (const language of ['fr', 'en']) {
    const html = renderRecentWorkspaces(listing, language, 'Fictional & <client>');
    assert.match(html, /method="post" action="\/internal\/recent-workspaces\?lang=(fr|en)"/);
    assert.match(html, /name="q" type="search" maxlength="80"/);
    assert.match(html, /value="Fictional &amp; &lt;client&gt;"/);
    assert.match(html, /Fictional &amp; &lt;client&gt;/);
    assert.doesNotMatch(html, /\?lang=(fr|en)&amp;q=/);
    assert.doesNotMatch(html, /<script|Fictional & <client>/);
    assert.match(html, /form-action 'self'/);
  }
  assert.match(renderRecentWorkspaces({ status: 'WORKSPACES_ONLY', workspaces: [] }, 'en', 'old'),
    /No saved drafts match this search/);
  assert.throws(() => renderRecentWorkspaces(listing, 'fr', 'x'.repeat(81)), TypeError);
});

test('search route validates same-origin form, bounds body, denies credentials and does not log a query in URLs', async () => {
  const calls = [];
  await withServer({ async list(args) {
    calls.push(args);
    if (args.token !== TOKEN) throw new WorkspaceError('UNAUTHORIZED', 401);
    return listing;
  } }, async base => {
    const ok = await postForm(base, 'q=' + encodeURIComponent('Fictional & <client>'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
    assert.match(ok.body, /value="Fictional &amp; &lt;client&gt;"/);
    assert.deepEqual(calls.map(call => call.query), ['Fictional & <client>']);
    const reset = await fetch(base + '/internal/recent-workspaces?lang=fr', {
      headers: { Cookie: `${COOKIE_NAME}=${TOKEN}` },
    });
    assert.equal(reset.status, 200);
    assert.equal(calls.at(-1).query, '');
    for (const [body, headers, status] of [
      ['q=old', { Origin: 'https://evil.example.test' }, 403],
      ['q=old', { Host: 'evil.example.test' }, 403],
      ['q=old', { 'Sec-Fetch-Site': 'cross-site' }, 403],
      ['q=old', { Origin: '' }, 403],
      ['q=old', { Authorization: `Bearer ${TOKEN}` }, 401],
      ['q=old', { 'X-Admin-Key': 'synthetic-admin' }, 401],
      ['q=old', { Cookie: `${COOKIE_NAME}=bad` }, 401],
      ['q=old', { 'Content-Type': 'application/json' }, 415],
      ['q=x&q=y', {}, 422],
      ['bad=x', {}, 422],
      ['q=' + 'x'.repeat(81), {}, 422],
      ['q=%0A', {}, 422],
      ['q=' + 'x'.repeat(520), {}, 413],
    ]) {
      const response = await postForm(base, body, headers);
      assert.equal(response.status, status, `${body.slice(0, 24)} => ${status}`);
    }
    assert.equal(calls.length, 2, 'Invalid requests must not reach the listing store');
    assert.equal((await fetch(base + '/internal/recent-workspaces?lang=fr&q=Fictional', {
      headers: { Cookie: `${COOKIE_NAME}=${TOKEN}` },
    })).status, 422);
    assert.equal(calls.length, 2);
  });
});

test('malformed search and token are rejected before database access, with no SQL error disclosure', async () => {
  let reads = 0;
  const store = createRecentWorkspaceStore({ businessId: 'fictional', pool: { async query() {
    reads++;
    throw Error('private synthetic SQL diagnostic');
  } } });
  await assert.rejects(store.list({ token: 'invalid', query: 'abc' }), error =>
    error instanceof WorkspaceError && error.code === 'UNAUTHORIZED');
  for (const query of [10, 'x'.repeat(81), 'line\nbreak']) {
    await assert.rejects(store.list({ token: TOKEN, query }), error =>
      error instanceof WorkspaceError && error.code === 'INVALID_SEARCH' && error.statusCode === 422);
  }
  assert.equal(reads, 0);
  await assert.rejects(store.list({ token: TOKEN, query: 'abc' }), error =>
    error instanceof WorkspaceError && error.code === 'STORAGE_UNAVAILABLE' &&
    !String(error.message).includes('private synthetic'));
  assert.equal(reads, 1);
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('PostgreSQL: find draft beyond 20, literal %/_ search, owner/tenant scope and revocation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const tenant = 'search-' + crypto.randomUUID();
    const otherTenant = 'search-foreign-' + crypto.randomUUID();
    async function staff(businessId) {
      const result = await pool.query(`INSERT INTO facturations_staff_users
        (business_id,email_normalized,role,password_salt,password_hash,email_verified_at)
        VALUES ($1,$2,'STAFF',$3,$4,now()) RETURNING id`,
      [businessId, crypto.randomUUID() + '@example.test', Buffer.alloc(16), Buffer.alloc(64)]);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(`INSERT INTO facturations_staff_sessions
        (business_id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '12 hours')`,
      [businessId, result.rows[0].id, crypto.createHash('sha256').update(token).digest()]);
      return { id: result.rows[0].id, token };
    }
    try {
      const owner = await staff(tenant);
      const colleague = await staff(tenant);
      const outsider = await staff(otherTenant);
      const workspace = createDraftWorkspaceStore({ pool, businessId: tenant });
      const foreignWorkspace = createDraftWorkspaceStore({ pool, businessId: otherTenant });
      const recent = createRecentWorkspaceStore({ pool, businessId: tenant });
      const foreignRecent = createRecentWorkspaceStore({ pool, businessId: otherTenant });
      async function save(store, token, customerName) {
        return store.create({ token, creationKey: crypto.randomUUID().replaceAll('-', ''),
          content: { currency: 'CAD', customer: { name: customerName }, notes: 'Fictional private notes' } });
      }
      const old = await save(workspace, owner.token, 'Fictional_%_archive');
      for (let n = 0; n < 21; n++) await save(workspace, owner.token, `New fictional customer ${n}`);
      await save(workspace, colleague.token, 'Fictional_%_archive colleague');
      await save(foreignWorkspace, outsider.token, 'Fictional_%_archive foreign');
      const recentRows = await recent.list({ token: owner.token });
      assert.equal(recentRows.workspaces.length, 20);
      assert.ok(!recentRows.workspaces.some(item => item.id === old.id));
      for (const query of ['fictional_%_', '%_', 'ARCHIVE']) {
        const filtered = await recent.list({ token: owner.token, query });
        if (query === 'fictional_%_' || query === '%_' || query === 'ARCHIVE') {
          assert.equal(filtered.workspaces.length, 1);
          assert.equal(filtered.workspaces[0].id, old.id);
          assert.deepEqual(Object.keys(filtered.workspaces[0]).sort(), ['customerName', 'id', 'revision', 'updatedAt']);
        }
      }
      assert.equal((await recent.list({ token: owner.token, query: 'nothing matches' })).workspaces.length, 0);
      assert.equal((await recent.list({ token: colleague.token, query: '%_' })).workspaces.length, 1);
      assert.equal((await foreignRecent.list({ token: outsider.token, query: '%_' })).workspaces.length, 1);
      await assert.rejects(recent.list({ token: outsider.token, query: '%_' }), error =>
        error instanceof WorkspaceError && error.code === 'UNAUTHORIZED');
      await pool.query('UPDATE facturations_staff_sessions SET revoked_at=now() WHERE business_id=$1 AND user_id=$2',
        [tenant, owner.id]);
      await assert.rejects(recent.list({ token: owner.token, query: '%_' }), error =>
        error instanceof WorkspaceError && error.code === 'UNAUTHORIZED');
      const count = await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant]);
      assert.equal(count.rows[0].n, 0);
    } finally { await pool.end(); }
  });
