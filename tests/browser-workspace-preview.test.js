'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { COOKIE_NAME } = require('../src/staff-session-cookie');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');
const { previewDraft } = require('../src/draft-preview');
const { attachBrowserWorkspacePreview, renderWorkspacePreview } = require('../src/browser-workspace-preview');
const { renderRecentWorkspaces } = require('../src/browser-recent-workspaces');

const TOKEN = 'A'.repeat(43);
const ID = '11111111-1111-4111-8111-111111111111';
const PATH = `/internal/workspaces/${ID}/preview`;
const cookie = token => ({ Cookie: `${COOKIE_NAME}=${token}` });
const content = Object.freeze({
  currency: 'CAD',
  customer: { name: '<img src=x onerror=alert(1)>', email: 'fictional@example.test',
    address: '<svg onload=alert(1)>' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: '<script>alert(1)</script>',
  lines: [{ description: '<b>Fictional service</b>', quantity: 2,
    unitPriceCents: 1250, discountCents: 100, taxable: true }],
  taxes: [{ code: 'TEST', label: '<test rate>', rateMilliPercent: 5000 }],
});
const row = Object.freeze({ id: ID, revision: 3, content, status: 'WORK_IN_PROGRESS',
  invoiceIssued: false, emailed: false });

async function withServer(workspaceStore, run) {
  const server = createServer({ config: { businessId: 'fictional-preview', adminKey: 'synthetic-admin', waveToken: null } });
  attachBrowserWorkspacePreview(server, { origin: 'https://fictional.example.test', workspaceStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('preview uses server-calculated cents, escapes every client-supplied field, and never claims issuance', () => {
  const preview = previewDraft(content);
  assert.equal(preview.subtotalCents, 2400);
  assert.equal(preview.taxTotalCents, 120);
  assert.equal(preview.totalCents, 2520);
  for (const [lang, total] of [['fr', '25,20'], ['en', '25.20']]) {
    const html = renderWorkspacePreview({ preview, id: ID, revision: 3, language: lang });
    assert.match(html, new RegExp(`<html lang="${lang}"`));
    assert.match(html, new RegExp(total));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
    assert.match(html, /&lt;b&gt;Fictional service&lt;\/b&gt;/);
    assert.match(html, /&lt;test rate&gt;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script|<svg|<img|<b>Fictional/);
    assert.match(html, new RegExp(`/internal/editor\\?lang=${lang}&amp;id=${ID}`));
    assert.match(html, /5\.000%/);
    assert.match(html, /AUCUNE FACTURE ÉMISE|NO INVOICE ISSUED/);
    assert.doesNotMatch(html, /synthetic-admin/);
  }
  assert.throws(() => renderWorkspacePreview({ preview, id: 'javascript:alert(1)', revision: 3 }), TypeError);
  assert.throws(() => renderWorkspacePreview({ preview, id: ID, revision: 3, language: 'es' }), TypeError);
  const index = renderRecentWorkspaces({ status: 'WORKSPACES_ONLY', workspaces: [{
    id: ID, revision: 3, updatedAt: '2026-09-21T03:00:00.000Z', customerName: '<img src=x>',
  }] }, 'fr');
  assert.match(index, new RegExp(`/internal/workspaces/${ID}/preview\\?lang=fr`));
  assert.match(index, /Aperçu calculé \(si complet\)/);
  assert.doesNotMatch(index, /<img src=x>/);
});

test('HTTP preview accepts only a staff session and GET, returns private HTML without writes', async () => {
  let reads = 0;
  const store = { async load({ token, workspaceId }) {
    reads++;
    assert.equal(workspaceId, ID);
    if (token !== TOKEN) throw new WorkspaceError('UNAUTHORIZED', 401);
    return row;
  } };
  await withServer(store, async base => {
    assert.equal((await fetch(base + PATH)).status, 401);
    assert.equal((await fetch(base + PATH, { headers: cookie('B'.repeat(43)) })).status, 401);
    assert.equal((await fetch(base + PATH, { headers: { ...cookie(TOKEN), 'X-Admin-Key': 'synthetic-admin' } })).status, 401);
    assert.equal((await fetch(base + PATH, { headers: { ...cookie(TOKEN), Authorization: `Bearer ${TOKEN}` } })).status, 401);
    assert.equal((await fetch(base + PATH, { headers: cookie(TOKEN), method: 'POST' })).status, 405);
    for (const path of [`${PATH}?lang=fr&lang=en`, `${PATH}?key=fake`, `${PATH}?lang=es`,
      '/internal/workspaces/bad/preview']) {
      assert.equal((await fetch(base + path, { headers: cookie(TOKEN) })).status, 422);
    }
    assert.equal(reads, 0);
    const response = await fetch(base + PATH + '?lang=fr', { headers: cookie(TOKEN) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    assert.match(await response.text(), /25,20/);
    assert.equal(reads, 1);
  });
});

test('incomplete working notes cannot be presented as calculated invoice totals', async () => {
  await withServer({ async load() { return { ...row, content: { currency: 'CAD',
    customer: { name: 'Fictional customer' }, notes: 'Work in progress' } }; } }, async base => {
    const response = await fetch(base + PATH + '?lang=en', { headers: cookie(TOKEN) });
    assert.equal(response.status, 422);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assert.match(html, /does not yet contain all the data/);
    assert.doesNotMatch(html, /Calculated total|CA\$25/);
  });
  await withServer({ async load() { throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404); } }, async base => {
    assert.equal((await fetch(base + PATH, { headers: cookie(TOKEN) })).status, 404);
  });
  await withServer({ async load() { throw new Error('synthetic storage failure'); } }, async base => {
    assert.equal((await fetch(base + PATH, { headers: cookie(TOKEN) })).status, 503);
  });
  await withServer({ async load() { return { ...row, invoiceIssued: true }; } }, async base => {
    assert.equal((await fetch(base + PATH, { headers: cookie(TOKEN) })).status, 503);
  });
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL: preview is owner-only, tenant-limited, and denied after session revocation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const tenant = 'preview-' + crypto.randomUUID();
    const foreignTenant = 'preview-foreign-' + crypto.randomUUID();
    async function staff(businessId) {
      const found = await pool.query(
        `INSERT INTO facturations_staff_users
         (business_id,email_normalized,role,password_salt,password_hash,email_verified_at)
         VALUES ($1,$2,'STAFF',$3,$4,now()) RETURNING id`,
        [businessId, crypto.randomUUID() + '@example.test', Buffer.alloc(16), Buffer.alloc(64)]);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO facturations_staff_sessions (business_id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,now()+interval '12 hours')`,
        [businessId, found.rows[0].id, crypto.createHash('sha256').update(token).digest()]);
      return { id: found.rows[0].id, token };
    }
    try {
      const owner = await staff(tenant);
      const colleague = await staff(tenant);
      const outsider = await staff(foreignTenant);
      const store = createDraftWorkspaceStore({ pool, businessId: tenant });
      const created = await store.create({ token: owner.token,
        creationKey: crypto.randomUUID().replace(/-/g, ''), content });
      await withServer(store, async base => {
        const path = `/internal/workspaces/${created.id}/preview`;
        assert.equal((await fetch(base + path, { headers: cookie(colleague.token) })).status, 404);
        assert.equal((await fetch(base + path, { headers: cookie(outsider.token) })).status, 401);
        const own = await fetch(base + path + '?lang=en', { headers: cookie(owner.token) });
        assert.equal(own.status, 200);
        assert.match(await own.text(), /CA\$25\.20/);
        await pool.query(
          'UPDATE facturations_staff_sessions SET revoked_at=now() WHERE business_id=$1 AND user_id=$2',
          [tenant, owner.id]);
        assert.equal((await fetch(base + path, { headers: cookie(owner.token) })).status, 401);
      });
      const snapshots = await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant]);
      assert.equal(snapshots.rows[0].n, 0);
    } finally { await pool.end(); }
  });
