'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserAiAssistantPage, renderPage, CLIENT } = require('../src/browser-ai-assistant-page');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'C'.repeat(43);
const OTHER = 'D'.repeat(43);
const TENANT = 'fictional-ai-page';
const cookie = token => `${COOKIE_NAME}=${token}`;

async function withServer(run) {
  const state = { revoked: false, unavailable: false };
  const calls = { session: 0 };
  const staffAuthStore = {
    async getSession(token) {
      calls.session += 1;
      if (state.unavailable) throw new Error('synthetic');
      return token === TOKEN && !state.revoked
        ? { role: 'OWNER', businessId: TENANT }
        : null;
    },
  };
  const server = createServer({
    config: { businessId: TENANT, adminKey: 'synthetic-admin-key', waveToken: null },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  attachBrowserAiAssistantPage(server, { staffAuthStore });
  try { await run({ base, calls, state }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('assistant page is bilingual, mobile-ready and contains no external assets or credentials', () => {
  for (const [language, title] of [['fr', 'Assistant Facturations'], ['en', 'Facturations Assistant']]) {
    const html = renderPage(language);
    assert.match(html, new RegExp(`<html lang="${language}"`));
    assert.match(html, new RegExp(title));
    assert.match(html, /<script src="\/internal\/assistant-client\.js" defer><\/script>/);
    assert.match(html, /id="assistant-copy" type="application\/json"|type="application\/json" id="assistant-copy"/);
    assert.doesNotMatch(html, /https:\/\/(?!127\.0\.0\.1)|OPENAI_API_KEY|X-Admin-Key|FACTURATIONS_DATABASE_URL/);
    assert.match(html, /@media\(max-width:760px\)/);
    assert.match(html, /prefers-reduced-motion/);
  }
  assert.throws(() => renderPage('es'), TypeError);
});

test('assistant client only calls same-origin CSRF/help routes and never stores prompts', () => {
  assert.match(CLIENT, /\/internal\/assistant\/csrf/);
  assert.match(CLIENT, /\/internal\/assistant\/help/);
  assert.match(CLIENT, /screenId: 'assistant'/);
  assert.match(CLIENT, /credentials: 'same-origin'/);
  assert.doesNotMatch(CLIENT, /localStorage|sessionStorage|OPENAI_API_KEY|X-Admin-Key|Authorization/);
});

test('assistant page and script require a live staff session and reject admin or bearer auth', async () => {
  await withServer(async ({ base, state }) => {
    assert.equal((await fetch(base + '/internal/assistant?lang=fr')).status, 401);
    assert.equal((await fetch(base + '/internal/assistant-client.js')).status, 401);

    const page = await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(TOKEN) },
    });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(await page.text(), /Assistant Facturations/);

    const script = await fetch(base + '/internal/assistant-client.js', {
      headers: { Cookie: cookie(TOKEN) },
    });
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');

    assert.equal((await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(TOKEN), Authorization: 'Bearer x' },
    })).status, 401);
    assert.equal((await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(TOKEN), 'X-Admin-Key': 'synthetic-admin-key' },
    })).status, 401);
    assert.equal((await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(OTHER) },
    })).status, 401);

    state.revoked = true;
    assert.equal((await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(TOKEN) },
    })).status, 401);

    state.revoked = false;
    state.unavailable = true;
    assert.equal((await fetch(base + '/internal/assistant?lang=fr', {
      headers: { Cookie: cookie(TOKEN) },
    })).status, 503);
  });
});

test('assistant page bounds language/query/method and script query', async () => {
  await withServer(async ({ base }) => {
    const headers = { Cookie: cookie(TOKEN) };
    for (const path of [
      '/internal/assistant?lang=es',
      '/internal/assistant?lang=fr&lang=en',
      '/internal/assistant?lang=fr&token=x',
      '/internal/assistant-client.js?x=1',
    ]) {
      assert.equal((await fetch(base + path, { headers })).status, 422);
    }
    assert.equal((await fetch(base + '/internal/assistant?lang=en', {
      method: 'POST', headers,
    })).status, 405);
    assert.equal((await fetch(base + '/internal/assistant-client.js', {
      method: 'POST', headers,
    })).status, 405);
  });
});
