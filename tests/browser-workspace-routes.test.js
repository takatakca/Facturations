'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserWorkspaceRoutes } = require('../src/browser-workspace-routes');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const TENANT = 'fictional-workspace-browser';
const ENCRYPTION_KEY = '7'.repeat(64); // Synthetic fixture, NOT a real MFA key.
const CREATION_KEY = 'fictional-key-123456789';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const CONTENT = { currency: 'CAD', notes: 'Unfinished fictional work' };

async function withServer(run) {
  const calls = { create: 0, load: 0, save: 0, session: 0 };
  const state = { revoked: false, unavailable: false, revision: 0, content: null };
  const staffAuthStore = { async getSession(token) {
    calls.session++;
    if (state.unavailable) throw new Error('synthetic failure');
    return token === TOKEN && !state.revoked ? { role: 'STAFF', businessId: TENANT } : null;
  } };
  const workspaceStore = {
    async create({ token, creationKey, content }) {
      calls.create++;
      if (token !== TOKEN || state.revoked) throw new WorkspaceError('UNAUTHORIZED', 401);
      if (creationKey !== CREATION_KEY) throw new WorkspaceError('INVALID_CREATION_KEY', 422);
      if (state.revision) throw new WorkspaceError('WORKSPACE_CREATION_CONFLICT', 409);
      state.revision = 1; state.content = content;
      return { id: workspaceId, revision: 1, content, status: 'WORK_IN_PROGRESS' };
    },
    async load({ token, workspaceId: id }) {
      calls.load++;
      if (token !== TOKEN || state.revoked) throw new WorkspaceError('UNAUTHORIZED', 401);
      if (id !== workspaceId || !state.revision) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
      return { id, revision: state.revision, content: state.content, status: 'WORK_IN_PROGRESS' };
    },
    async save({ token, workspaceId: id, expectedRevision, content }) {
      calls.save++;
      if (token !== TOKEN || state.revoked) throw new WorkspaceError('UNAUTHORIZED', 401);
      if (id !== workspaceId || !state.revision) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
      if (expectedRevision !== state.revision) throw new WorkspaceError('WORKSPACE_REVISION_CONFLICT', 409);
      state.revision++; state.content = content;
      return { id, revision: state.revision, content, status: 'WORK_IN_PROGRESS' };
    },
  };
  const server = createServer({ config: { businessId: TENANT, adminKey: 'fictional-private-admin', waveToken: null } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = `https://127.0.0.1:${server.address().port}`;
  attachBrowserWorkspaceRoutes(server, { origin, encryptionKeyHex: ENCRYPTION_KEY, staffAuthStore, workspaceStore });
  try { await run({ base, origin, calls, state }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const cookie = token => `${COOKIE_NAME}=${token}`;
const post = (base, origin, path, body, headers = {}) => fetch(base + path, {
  method: path.includes(workspaceId) ? 'PUT' : 'POST', redirect: 'manual',
  headers: { Cookie: cookie(TOKEN), Origin: origin, 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('cookie-only CSRF token enables create, reload and revision-safe save without granting old API writes', async () => {
  await withServer(async ({ base, origin, calls }) => {
    const pre = await fetch(base + '/internal/workspaces/csrf');
    assert.equal(pre.status, 401);
    const csrfResponse = await fetch(base + '/internal/workspaces/csrf', { headers: { Cookie: cookie(TOKEN) } });
    assert.equal(csrfResponse.status, 200);
    assert.equal(csrfResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(csrfResponse.headers.get('access-control-allow-origin'), null);
    const { csrfToken } = await csrfResponse.json();
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const h = { 'X-Facturations-CSRF': csrfToken };
    const created = await post(base, origin, '/internal/workspaces', { creationKey: CREATION_KEY, content: CONTENT }, h);
    assert.equal(created.status, 200);
    assert.equal((await created.json()).revision, 1);
    const read = await fetch(base + '/internal/workspaces/' + workspaceId, { headers: { Cookie: cookie(TOKEN) } });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).content, CONTENT);
    const saved = await post(base, origin, '/internal/workspaces/' + workspaceId,
      { expectedRevision: 1, content: { notes: 'Saved revision two' } }, h);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, 2);
    const stale = await post(base, origin, '/internal/workspaces/' + workspaceId,
      { expectedRevision: 1, content: { notes: 'stale' } }, h);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'WORKSPACE_REVISION_CONFLICT');
    assert.equal((await (await fetch(base + '/internal/workspaces/' + workspaceId,
      { headers: { Cookie: cookie(TOKEN) } })).json()).content.notes, 'Saved revision two');
    assert.equal((await fetch(base + '/api/drafts', { method: 'POST', headers: { Cookie: cookie(TOKEN) } })).status, 401);
    assert.deepEqual({ create: calls.create, save: calls.save }, { create: 1, save: 2 });
  });
});

test('cross-origin, bearer/admin, missing CSRF and malformed requests cannot write', async () => {
  await withServer(async ({ base, origin, calls }) => {
    const csrfToken = (await (await fetch(base + '/internal/workspaces/csrf',
      { headers: { Cookie: cookie(TOKEN) } })).json()).csrfToken;
    const payload = { creationKey: CREATION_KEY, content: CONTENT };
    const attempts = [
      post(base, 'https://other.example.test', '/internal/workspaces', payload,
        { 'X-Facturations-CSRF': csrfToken }),
      post(base, origin, '/internal/workspaces', payload,
        { 'Sec-Fetch-Site': 'cross-site', 'X-Facturations-CSRF': csrfToken }),
      post(base, origin, '/internal/workspaces', payload),
      post(base, origin, '/internal/workspaces', payload,
        { 'X-Facturations-CSRF': 'a'.repeat(43) }),
      post(base, origin, '/internal/workspaces', payload,
        { 'X-Facturations-CSRF': csrfToken, Authorization: `Bearer ${TOKEN}` }),
      post(base, origin, '/internal/workspaces', payload,
        { 'X-Facturations-CSRF': csrfToken, 'X-Admin-Key': 'fictional-private-admin' }),
    ];
    for (const response of await Promise.all(attempts)) assert.ok([401, 403].includes(response.status));
    assert.equal(calls.create, 0);
    assert.equal((await fetch(base + '/internal/workspaces/csrf',
      { headers: { Cookie: cookie(TOKEN), Authorization: `Bearer ${TOKEN}` } })).status, 401);
    assert.equal((await fetch(base + '/internal/workspaces?token=anything',
      { headers: { Cookie: cookie(TOKEN) } })).status, 422);
    assert.equal((await fetch(base + '/internal/workspaces', { headers: { Cookie: cookie(TOKEN) } })).status, 405);
    assert.equal((await post(base, origin, '/internal/workspaces', payload,
      { 'X-Facturations-CSRF': csrfToken, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(base, origin, '/internal/workspaces', '{',
      { 'X-Facturations-CSRF': csrfToken })).status, 400);
    assert.equal((await post(base, origin, '/internal/workspaces', 'x'.repeat(33000),
      { 'X-Facturations-CSRF': csrfToken })).status, 413);
    assert.equal((await post(base, origin, '/internal/workspaces', { ...payload, businessId: 'foreign' },
      { 'X-Facturations-CSRF': csrfToken })).status, 422);
    assert.equal(calls.create, 0);
  });
});

test('revocation, wrong cookie, missing workspace and unavailable session fail closed', async () => {
  await withServer(async ({ base, origin, calls, state }) => {
    const bad = await fetch(base + '/internal/workspaces/csrf', { headers: { Cookie: cookie(OTHER) } });
    assert.equal(bad.status, 401);
    const csrfToken = (await (await fetch(base + '/internal/workspaces/csrf',
      { headers: { Cookie: cookie(TOKEN) } })).json()).csrfToken;
    assert.equal((await fetch(base + '/internal/workspaces/' + workspaceId,
      { headers: { Cookie: cookie(TOKEN) } })).status, 404);
    state.revoked = true;
    assert.equal((await fetch(base + '/internal/workspaces/csrf',
      { headers: { Cookie: cookie(TOKEN) } })).status, 401);
    assert.equal((await post(base, origin, '/internal/workspaces',
      { creationKey: CREATION_KEY, content: CONTENT }, { 'X-Facturations-CSRF': csrfToken })).status, 401);
    assert.equal(calls.create, 1); // Rejected by the store without modifying anything.
    state.unavailable = true;
    assert.equal((await fetch(base + '/internal/workspaces/csrf',
      { headers: { Cookie: cookie(TOKEN) } })).status, 503);
  });
});

// A real disposable database verifies the HTTP-to-store boundary, not only mocked methods.
const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL: cookie workspace changes remain staff-scoped after revocation',
  { skip: !DATABASE }, async () => {
    const u = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(u.hostname));
    assert.equal(u.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const tenant = 'http-workspace-' + crypto.randomUUID();
    const outsiderTenant = 'http-outside-' + crypto.randomUUID();
    async function makeStaff(business) {
      const inserted = await pool.query(
        `INSERT INTO facturations_staff_users (business_id,email_normalized,role,password_salt,password_hash,email_verified_at)
         VALUES ($1,$2,'STAFF',$3,$4,now()) RETURNING id`,
        [business, crypto.randomUUID() + '@example.test', Buffer.alloc(16), Buffer.alloc(64)]);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(`INSERT INTO facturations_staff_sessions (business_id,user_id,token_hash,expires_at)
        VALUES ($1,$2,$3,now()+interval '12 hours')`,
      [business, inserted.rows[0].id, crypto.createHash('sha256').update(token).digest()]);
      return { id: inserted.rows[0].id, token };
    }
    const server = createServer({ config: { businessId: tenant, adminKey: 'fictional-private-admin', waveToken: null } });
    try {
      const owner = await makeStaff(tenant);
      const colleague = await makeStaff(tenant);
      const foreign = await makeStaff(outsiderTenant);
      const store = createDraftWorkspaceStore({ pool, businessId: tenant });
      const staffAuthStore = { async getSession(token) {
        const found = await pool.query(`SELECT u.role FROM facturations_staff_sessions s JOIN facturations_staff_users u
          ON u.id=s.user_id AND u.business_id=s.business_id
          WHERE s.business_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL`,
          [tenant, crypto.createHash('sha256').update(token).digest()]);
        return found.rows[0] || null;
      } };
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const base = `http://127.0.0.1:${server.address().port}`;
      const origin = `https://127.0.0.1:${server.address().port}`;
      attachBrowserWorkspaceRoutes(server, { origin, encryptionKeyHex: ENCRYPTION_KEY,
        staffAuthStore, workspaceStore: store });
      const csrfToken = (await (await fetch(base + '/internal/workspaces/csrf',
        { headers: { Cookie: cookie(owner.token) } })).json()).csrfToken;
      const created = await fetch(base + '/internal/workspaces', {
        method: 'POST', headers: { Cookie: cookie(owner.token), Origin: origin,
          'Content-Type': 'application/json', 'X-Facturations-CSRF': csrfToken },
        body: JSON.stringify({ creationKey: crypto.randomUUID().replace(/-/g, ''), content: CONTENT }),
      });
      assert.equal(created.status, 200);
      const saved = await created.json();
      for (const token of [colleague.token, foreign.token]) {
        assert.equal((await fetch(base + '/internal/workspaces/' + saved.id,
          { headers: { Cookie: cookie(token) } })).status, token === colleague.token ? 404 : 401);
      }
      await pool.query('UPDATE facturations_staff_sessions SET revoked_at=now() WHERE business_id=$1 AND user_id=$2',
        [tenant, owner.id]);
      assert.equal((await fetch(base + '/internal/workspaces/' + saved.id,
        { headers: { Cookie: cookie(owner.token) } })).status, 401);
      assert.equal((await fetch(base + '/internal/workspaces/' + saved.id, {
        method: 'PUT', headers: { Cookie: cookie(owner.token), Origin: origin,
          'Content-Type': 'application/json', 'X-Facturations-CSRF': csrfToken },
        body: JSON.stringify({ expectedRevision: 1, content: { notes: 'denied' } }),
      })).status, 401);
      const row = await pool.query('SELECT revision FROM facturations_draft_workspaces WHERE business_id=$1 AND id=$2',
        [tenant, saved.id]);
      assert.equal(row.rows[0].revision, 1);
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await pool.end();
    }
  });
