'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserStaffLogin } = require('../src/browser-staff-login');
const { attachReadOnlyDashboardCookie } = require('../src/browser-dashboard-session');
const { StaffAuthError } = require('../src/staff-auth-store');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'T'.repeat(43); // Synthetic fixture, never a live token.
const BUSINESS = 'fictional-browser-tenant';
const EMAIL = 'owner@example.test';
const PASSWORD = 'synthetic-strong-password-2026';
const GOOD_CODE = '123456';

async function withServer(run) {
  const calls = { reserve: 0, reset: 0, auth: 0, revoke: 0, summary: 0, drafts: 0 };
  const state = { limited: false, limiterError: false, resetError: false, revoked: false };
  const staffAuthStore = {
    async authenticateWithTotp({ email, password, code }) {
      calls.auth++;
      if (email !== EMAIL || password !== PASSWORD || code !== GOOD_CODE) {
        throw new StaffAuthError('INVALID_CREDENTIALS');
      }
      return { token: TOKEN, staff: { id: '11111111-1111-4111-8111-111111111111',
        businessId: BUSINESS, role: 'OWNER' } };
    },
    async getSession(token) {
      return token === TOKEN && !state.revoked ? {
        id: '11111111-1111-4111-8111-111111111111', businessId: BUSINESS, role: 'OWNER',
      } : null;
    },
    async revokeSession(token) {
      calls.revoke++;
      if (token === TOKEN) state.revoked = true;
      return token === TOKEN;
    },
  };
  const attemptLimit = {
    async reserve(email) {
      calls.reserve++;
      if (state.limiterError) throw new Error('synthetic DB failure');
      return !state.limited && email === EMAIL;
    },
    async reset() {
      calls.reset++;
      if (state.resetError) throw new Error('synthetic DB failure');
      return true;
    },
  };
  const dashboardStore = {
    async getSummary() {
      calls.summary++;
      return { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '0', draftTotalCents: '0',
        revenueAvailable: false, issuedInvoicesAvailable: false, paymentsAvailable: false };
    },
    async listDrafts() {
      calls.drafts++;
      return { status: 'DRAFTS_ONLY', drafts: [] };
    },
  };
  const server = createServer({ config: { businessId: BUSINESS, adminKey: 'synthetic-private-admin-key', waveToken: null },
    staffAuthStore, dashboardStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = `https://127.0.0.1:${server.address().port}`;
  attachBrowserStaffLogin(server, { origin, staffAuthStore, attemptLimit });
  attachReadOnlyDashboardCookie(server);
  try { await run({ base, origin, calls, state }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function post(base, origin, path, fields, extraHeaders = {}) {
  return fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(fields),
  });
}

const valid = Object.freeze({ email: EMAIL, password: PASSWORD, code: GOOD_CODE });

test('bilingual accessible HTML and cookie-only dashboard after fully verified login', async () => {
  await withServer(async ({ base, origin, calls }) => {
    for (const [lang, expected] of [['fr', 'Adresse courriel'], ['en', 'Email address']]) {
      const page = await fetch(base + `/internal/login?lang=${lang}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
      const text = await page.text();
      assert.match(text, new RegExp(`<html lang="${lang}"`));
      assert.ok(text.includes(expected));
      assert.match(text, /autocomplete="one-time-code"/);
      assert.doesNotMatch(text, /synthetic-private-admin-key/);
      assert.doesNotMatch(text, new RegExp(TOKEN));
    }
    assert.equal((await fetch(base + '/internal/dashboard')).status, 401);
    const result = await post(base, origin, '/internal/login?lang=en', valid);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/internal/dashboard?lang=en');
    const cookie = result.headers.get('set-cookie');
    assert.ok(cookie.startsWith(`${COOKIE_NAME}=${TOKEN};`));
    for (const directive of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(directive));
    assert.doesNotMatch(cookie, /Domain=/);
    assert.deepEqual({ reserve: calls.reserve, auth: calls.auth, reset: calls.reset },
      { reserve: 1, auth: 1, reset: 1 });
    const cookieHeader = `${COOKIE_NAME}=${TOKEN}`;
    for (const [lang, label] of [['fr', 'Se déconnecter'], ['en', 'Sign out']]) {
      const dashboard = await fetch(base + `/internal/dashboard?lang=${lang}`, { headers: { Cookie: cookieHeader } });
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.headers.get('content-security-policy'), /form-action 'self'/);
      const html = await dashboard.text();
      assert.ok(html.includes(`<form method="post" action="/internal/logout?lang=${lang}"><button class="signout" type="submit">${label}</button></form>`));
      assert.doesNotMatch(html, /synthetic-private-admin-key/);
      assert.doesNotMatch(html, new RegExp(TOKEN));
    }
    assert.equal((await fetch(base + '/api/dashboard/summary', { headers: { Cookie: cookieHeader } })).status, 401);
    const crossSite = await post(base, 'https://other.example.test', '/internal/logout?lang=en', {},
      { Cookie: cookieHeader });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.revoke, 0);
    assert.equal((await fetch(base + '/internal/logout?lang=en', { headers: { Cookie: cookieHeader } })).status, 405);
    const logout = await post(base, origin, '/internal/logout?lang=en', {}, { Cookie: cookieHeader });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/internal/login?lang=en');
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(calls.revoke, 1);
    assert.equal((await fetch(base + '/internal/dashboard', { headers: { Cookie: cookieHeader } })).status, 401);
  });
});

test('cross-site, unknown parameters, malformed forms and admin-key login bypass are denied before password verification', async () => {
  await withServer(async ({ base, origin, calls }) => {
    const forbidden = [
      post(base, 'https://other.example.test', '/internal/login', valid),
      post(base, origin, '/internal/login', valid, { 'Sec-Fetch-Site': 'cross-site' }),
      post(base, origin, '/internal/login', valid, { Authorization: `Bearer ${TOKEN}` }),
      post(base, origin, '/internal/login', valid, { 'X-Admin-Key': 'synthetic-private-admin-key' }),
    ];
    for (const result of await Promise.all(forbidden)) assert.equal(result.status, 403);
    assert.equal((await fetch(base + '/internal/login?lang=es')).status, 422);
    assert.equal((await fetch(base + '/internal/login?lang=fr&lang=en')).status, 422);
    assert.equal((await fetch(base + '/internal/login?next=https://other.example.test')).status, 422);
    assert.equal((await fetch(base + '/internal/logout')).status, 405);
    assert.equal((await post(base, origin, '/internal/login', { ...valid, extra: '1' })).status, 422);
    assert.equal((await post(base, origin, '/internal/login', { ...valid, code: '12' })).status, 422);
    assert.equal((await post(base, origin, '/internal/login', valid,
      { 'Content-Type': 'application/json' })).status, 415);
    const oversized = await fetch(base + '/internal/login', { method: 'POST', redirect: 'manual',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'x'.repeat(5000) });
    assert.equal(oversized.status, 413);
    assert.equal(calls.auth, 0);
    assert.equal(calls.reserve, 0);
  });
});

test('incorrect credentials, limiter and database errors never issue a cookie', async () => {
  await withServer(async ({ base, origin, calls, state }) => {
    const invalid = await post(base, origin, '/internal/login', { ...valid, password: 'incorrect-password-123456' });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get('set-cookie'), null);
    assert.doesNotMatch(await invalid.text(), /incorrect-password-123456/);
    state.limited = true;
    const limited = await post(base, origin, '/internal/login', valid);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('set-cookie'), null);
    assert.equal(calls.auth, 1);
    state.limited = false;
    state.limiterError = true;
    const unavailable = await post(base, origin, '/internal/login', valid);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('set-cookie'), null);
    state.limiterError = false;
    state.resetError = true;
    const reset = await post(base, origin, '/internal/login', valid);
    assert.equal(reset.status, 503);
    assert.equal(reset.headers.get('set-cookie'), null);
    assert.equal(calls.revoke, 1);
    assert.equal((await fetch(base + '/internal/dashboard', {
      headers: { Cookie: `${COOKIE_NAME}=${TOKEN}` },
    })).status, 401);
  });
});
