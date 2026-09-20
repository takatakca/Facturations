'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachReadOnlyDashboardCookie } = require('../src/browser-dashboard-session');
const { COOKIE_NAME, readStaffSessionCookie, createStaffSessionCookie, clearStaffSessionCookie } = require('../src/staff-session-cookie');

const TOKEN = 'T'.repeat(43); // Synthetic fixture, NOT an actual session.
const TENANT = 'synthetic-browser-business';
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

test('host-only session cookies require secure flags and reject malformed or duplicate values', () => {
  assert.equal(readStaffSessionCookie(`irrelevant=1; ${COOKIE}; theme=light`), TOKEN);
  assert.equal(readStaffSessionCookie(COOKIE), TOKEN);
  for (const header of [undefined, null, '', 'other=123', `${COOKIE}; ${COOKIE}`,
    `${COOKIE_NAME}=${'X'.repeat(42)}`, `${COOKIE_NAME}="${TOKEN}"`,
    `${COOKIE_NAME}=${TOKEN},other=1`, `${COOKIE_NAME}-shadow=${TOKEN}`,
    `${COOKIE}; ${COOKIE_NAME}=${'U'.repeat(43)}`, 'filler='.padEnd(4097, 'a')]) {
    assert.equal(readStaffSessionCookie(header), null);
  }
  assert.throws(() => createStaffSessionCookie('not-a-token'), TypeError);
  const issued = createStaffSessionCookie(TOKEN);
  assert.equal(issued, `${COOKIE}; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Strict`);
  assert.equal(clearStaffSessionCookie(), `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
  assert.doesNotMatch(issued, /Domain=/);
});

async function withServer(run) {
  const calls = { session: 0, summary: 0, list: 0 };
  const staffAuthStore = {
    async getSession(token) {
      calls.session++;
      if (token !== TOKEN) return null;
      return { id: '11111111-1111-4111-8111-111111111111', role: 'OWNER', businessId: TENANT };
    },
  };
  const dashboardStore = {
    async getSummary() {
      calls.summary++;
      return { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '0', draftTotalCents: '0',
        revenueAvailable: false, issuedInvoicesAvailable: false, paymentsAvailable: false };
    },
    async listDrafts() {
      calls.list++;
      return { status: 'DRAFTS_ONLY', drafts: [] };
    },
  };
  const server = attachReadOnlyDashboardCookie(createServer({
    config: { businessId: TENANT, adminKey: 'synthetic-private-admin-key', waveToken: null },
    staffAuthStore, dashboardStore,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('cookie unlocks only read-only HTML via a live tenant session; never API or admin access', async () => {
  await withServer(async (base, calls) => {
    const good = await fetch(base + '/internal/dashboard?lang=en', { headers: { Cookie: COOKIE } });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'private, no-store');
    assert.match(await good.text(), /Recent drafts/);
    assert.equal(good.headers.get('set-cookie'), null); // No login or cookie issuance here.
    assert.deepEqual(calls, { session: 1, summary: 1, list: 1 });

    for (const path of ['/api/dashboard/summary', '/api/drafts', '/api/wave/businesses']) {
      const response = await fetch(base + path, { headers: { Cookie: COOKIE } });
      assert.equal(response.status, 401);
    }
    for (const headers of [
      { Cookie: COOKIE, Authorization: 'Bearer invalid' },
      { Cookie: COOKIE, 'X-Admin-Key': 'synthetic-private-admin-key' },
      { Cookie: `${COOKIE}; ${COOKIE}` },
      { Cookie: `${COOKIE_NAME}=${'U'.repeat(43)}` },
    ]) {
      assert.equal((await fetch(base + '/internal/dashboard', { headers })).status, 401);
    }
    assert.deepEqual(calls, { session: 3, summary: 1, list: 1 });
    assert.equal((await fetch(base + '/internal/dashboard', { method: 'POST', headers: { Cookie: COOKIE } })).status, 405);
  });
});
