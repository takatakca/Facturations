'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { COOKIE_NAME } = require('../src/staff-session-cookie');
const { WorkspaceError } = require('../src/draft-workspace-store');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createRecentWorkspaceStore } = require('../src/recent-workspace-store');
const { attachBrowserRecentWorkspaces, renderRecentWorkspaces } = require('../src/browser-recent-workspaces');
const { renderDashboard } = require('../src/dashboard-view');

const TOKEN = 'A'.repeat(43);
const ID = '11111111-1111-4111-8111-111111111111';
const name = '<img src=x onerror=alert(1)> & "client"';
const summary = { status: 'WORKSPACES_ONLY', workspaces: [{
  id: ID, revision: 2, updatedAt: '2026-09-21T03:00:00.000Z', customerName: name,
}] };

async function withServer(recentStore, run) {
  const server = createServer({ config: { businessId: 'fictional-tenant', adminKey: 'synthetic-admin', waveToken: null } });
  attachBrowserRecentWorkspaces(server, { origin: 'https://example.test', recentStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('FR/EN index renders only escaped summaries and links to the staff-only editor', () => {
  for (const [lang, title] of [['fr', 'Mes brouillons de travail'], ['en', 'My working drafts']]) {
    const page = renderRecentWorkspaces(summary, lang);
    assert.match(page, new RegExp(`<html lang="${lang}"`));
    assert.match(page, new RegExp(title));
    assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;client&quot;'));
    assert.ok(!page.includes(name));
    assert.match(page, new RegExp(`/internal/editor\\?lang=${lang}&amp;id=${ID}`));
    assert.ok(!page.includes('<script'));
    assert.ok(!page.includes(TOKEN));
  }
  const empty = renderRecentWorkspaces({ status: 'WORKSPACES_ONLY', workspaces: [] });
  assert.match(empty, /Aucun brouillon enregistré/);
  assert.throws(() => renderRecentWorkspaces({ status: 'WORKSPACES_ONLY', workspaces: [
    { ...summary.workspaces[0], id: 'javascript:alert(1)' },
  ] }), TypeError);
  assert.throws(() => renderRecentWorkspaces({ status: 'WORKSPACES_ONLY', workspaces: Array(21).fill(summary.workspaces[0]) }), TypeError);
  assert.throws(() => renderRecentWorkspaces(summary, 'es'), TypeError);
  const dashboard = renderDashboard({
    language: 'fr',
    summary: { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '0', draftTotalCents: '0' },
    drafts: { status: 'DRAFTS_ONLY', drafts: [] },
  });
  assert.match(dashboard, /href="\/internal\/recent-workspaces\?lang=fr"/);
  assert.match(dashboard, /Mes brouillons enregistrés/);
  assert.equal((dashboard.match(/<form\b/g) || []).length, 1);
});

test('HTML listing fails closed for missing, revoked, wrong or admin/bearer credentials and bad requests', async () => {
  let calls = 0;
  const recentStore = { async list({ token }) {
    calls++;
    if (token !== TOKEN) throw new WorkspaceError('UNAUTHORIZED', 401);
    return summary;
  } };
  await withServer(recentStore, async base => {
    const cookie = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
    assert.equal((await fetch(base + '/internal/recent-workspaces')).status, 401);
    assert.equal((await fetch(base + '/internal/recent-workspaces', { headers: {
      'X-Admin-Key': 'synthetic-admin', ...cookie,
    } })).status, 401);
    assert.equal((await fetch(base + '/internal/recent-workspaces', { headers: {
      Authorization: `Bearer ${TOKEN}`, ...cookie,
    } })).status, 401);
    // POST is now a valid read-only search method, but never without same-origin proof.
    assert.equal((await fetch(base + '/internal/recent-workspaces', { headers: cookie, method: 'POST' })).status, 403);
    for (const path of ['/internal/recent-workspaces?lang=fr&lang=en',
      '/internal/recent-workspaces?token=anything', '/internal/recent-workspaces?lang=es']) {
      assert.equal((await fetch(base + path, { headers: cookie })).status, 422);
    }
    assert.equal(calls, 0);
    const response = await fetch(base + '/internal/recent-workspaces?lang=en', { headers: cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /My working drafts/);
    assert.equal(calls, 1);
  });
  await withServer({ async list() { throw new WorkspaceError('UNAUTHORIZED', 401); } }, async base => {
    assert.equal((await fetch(base + '/internal/recent-workspaces', { headers: {
      Cookie: `${COOKIE_NAME}=${TOKEN}`,
    } })).status, 401);
  });
  await withServer({ async list() { throw Error('synthetic storage outage'); } }, async base => {
    assert.equal((await fetch(base + '/internal/recent-workspaces', { headers: {
      Cookie: `${COOKIE_NAME}=${TOKEN}`,
    } })).status, 503);
  });
});

test('listing token format is validated before querying PostgreSQL', async () => {
  const store = createRecentWorkspaceStore({ businessId: 'synthetic-tenant', pool: {
    async query() { throw Error('should never query'); },
  } });
  await assert.rejects(store.list({ token: 'wrong' }), error =>
    error instanceof WorkspaceError && error.code === 'UNAUTHORIZED' && error.statusCode === 401);
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL lists only the owning staff, denies foreign tenant and revocation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const tenant = 'recent-' + crypto.randomUUID();
    const otherTenant = 'recent-foreign-' + crypto.randomUUID();
    async function staff(businessId) {
      const result = await pool.query(
        `INSERT INTO facturations_staff_users
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
      const store = createDraftWorkspaceStore({ pool, businessId: tenant });
      const foreignStore = createDraftWorkspaceStore({ pool, businessId: otherTenant });
      const recent = createRecentWorkspaceStore({ pool, businessId: tenant });
      const foreignRecent = createRecentWorkspaceStore({ pool, businessId: otherTenant });
      const a = await store.create({ token: owner.token, creationKey: crypto.randomUUID().replace(/-/g, ''),
        content: { currency: 'CAD', customer: { name }, notes: 'Private notes never returned in listing' } });
      const b = await store.create({ token: colleague.token, creationKey: crypto.randomUUID().replace(/-/g, ''),
        content: { currency: 'CAD', customer: { name: 'Other staff' }, notes: 'Other private notes' } });
      const c = await foreignStore.create({ token: outsider.token, creationKey: crypto.randomUUID().replace(/-/g, ''),
        content: { currency: 'CAD', customer: { name: 'Foreign company' } } });
      const own = await recent.list({ token: owner.token });
      assert.equal(own.status, 'WORKSPACES_ONLY');
      assert.equal(own.workspaces.length, 1);
      assert.equal(own.workspaces[0].id, a.id);
      assert.equal(own.workspaces[0].customerName, name);
      assert.deepEqual(Object.keys(own.workspaces[0]).sort(), ['customerName', 'id', 'revision', 'updatedAt']);
      assert.equal((await recent.list({ token: colleague.token })).workspaces[0].id, b.id);
      assert.equal((await foreignRecent.list({ token: outsider.token })).workspaces[0].id, c.id);
      await assert.rejects(recent.list({ token: outsider.token }), error =>
        error instanceof WorkspaceError && error.code === 'UNAUTHORIZED');
      await pool.query('UPDATE facturations_staff_sessions SET revoked_at=now() WHERE business_id=$1 AND user_id=$2',
        [tenant, owner.id]);
      await assert.rejects(recent.list({ token: owner.token }), error =>
        error instanceof WorkspaceError && error.code === 'UNAUTHORIZED');
      const count = await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant]);
      assert.equal(count.rows[0].n, 0);
    } finally { await pool.end(); }
  });
