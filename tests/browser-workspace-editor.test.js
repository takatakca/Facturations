'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserWorkspaceEditor, renderEditor } = require('../src/browser-workspace-editor');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'C'.repeat(43);
const ID = '22222222-2222-4222-8222-222222222222';
const csrfToken = 'D'.repeat(43);
const cookie = value => `${COOKIE_NAME}=${value}`;

async function withServer(run) {
  const state = { role: 'OWNER', unavailable: false, sessions: 0 };
  const staffAuthStore = { async getSession(value) {
    state.sessions++;
    if (state.unavailable) throw new Error('synthetic database failure');
    return value === TOKEN && state.role ? { role: state.role, businessId: 'fictional-editor' } : null;
  } };
  const server = createServer({ config: { businessId: 'fictional-editor', adminKey: 'fictional-internal', waveToken: null } });
  const origin = 'https://fictional.example.test';
  attachBrowserWorkspaceEditor(server, { origin, staffAuthStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run({ base: `http://127.0.0.1:${server.address().port}`, state }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('editor and script require current staff cookie and never accept admin or bearer headers', async () => {
  await withServer(async ({ base, state }) => {
    const page = '/internal/editor?lang=fr&id=' + ID;
    for (const path of [page, '/internal/editor-client.js']) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie('Z'.repeat(43)) } })).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie(TOKEN), 'X-Admin-Key': 'fictional-internal' } })).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie(TOKEN), Authorization: 'Bearer ' + TOKEN } })).status, 401);
      assert.equal((await fetch(base + path, { method: 'POST', headers: { Cookie: cookie(TOKEN) } })).status, 405);
    }
    state.role = 'VIEWER';
    assert.equal((await fetch(base + page, { headers: { Cookie: cookie(TOKEN) } })).status, 401);
    state.role = null;
    assert.equal((await fetch(base + page, { headers: { Cookie: cookie(TOKEN) } })).status, 401);
    state.role = 'STAFF';
    state.unavailable = true;
    assert.equal((await fetch(base + page, { headers: { Cookie: cookie(TOKEN) } })).status, 503);
  });
});

test('FR/EN private HTML and script use no-store and narrow CSP without exposing credentials', async () => {
  await withServer(async ({ base }) => {
    for (const lang of ['fr', 'en']) {
      const response = await fetch(base + `/internal/editor?lang=${lang}&id=${ID}`, {
        headers: { Cookie: cookie(TOKEN) },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'; connect-src 'self'/);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const html = await response.text();
      assert.match(html, new RegExp(`<html lang="${lang}"`));
      assert.match(html, /GROUPE TAKATAK/);
      assert.match(html, /\/internal\/editor-client\.js/);
      assert.match(html, /method="post" action="\/internal\/editor"/);
      assert.doesNotMatch(html, new RegExp(TOKEN));
      assert.doesNotMatch(html, /fictional-internal/);
      assert.doesNotMatch(html, /csrfToken/);
      assert.doesNotMatch(html, /<script(?! src)/);
    }
    const script = await fetch(base + '/internal/editor-client.js', { headers: { Cookie: cookie(TOKEN) } });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
    assert.equal(script.headers.get('cache-control'), 'private, no-store');
    assert.equal(script.headers.get('set-cookie'), null);
    assert.doesNotMatch(await script.text(), /fictional-internal/);
    for (const path of ['/internal/editor?lang=es', '/internal/editor?lang=fr&lang=en',
      '/internal/editor?id=not-a-uuid', '/internal/editor?token=fake',
      '/internal/editor-client.js?x=1']) {
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie(TOKEN) } })).status, 422);
    }
  });
  assert.throws(() => renderEditor('fr', '<img src=x>'), /Invalid editor parameters/);
  assert.throws(() => renderEditor('xx'), /Invalid editor parameters/);
});

// Exercise the actual browser JS in a minimal sandbox without third-party browser dependencies.
function browserHarness({ existing = null } = {}) {
  const events = new Map();
  const windowEvents = new Map();
  const elements = Object.fromEntries(['editor', 'customer', 'notes', 'save', 'reload', 'status'].map(id =>
    [id, { value: '', disabled: true, dataset: {}, textContent: '', addEventListener(type, listener) {
      events.set(id + ':' + type, listener);
    } }]));
  const calls = [];
  const server = { current: existing, conflict: false };
  const historyUrls = [];
  const fetchMock = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/internal/workspaces/csrf') return { ok: true, json: async () => ({ csrfToken }) };
    if (path === '/internal/workspaces/' + ID && (!options.method || options.method === 'GET')) {
      return server.current ? { ok: true, json: async () => server.current } : { ok: false, status: 404 };
    }
    if (server.conflict) return { ok: false, status: 409 };
    if (path !== '/internal/workspaces' && path !== '/internal/workspaces/' + ID) throw new Error('Unexpected path');
    const body = JSON.parse(options.body);
    if (path === '/internal/workspaces') {
      assert.match(body.creationKey, /^[a-f0-9]{32}$/);
      server.current = { id: ID, revision: 1, content: body.content,
        status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
    } else {
      assert.equal(body.expectedRevision, server.current.revision);
      server.current = { ...server.current, revision: server.current.revision + 1, content: body.content };
    }
    return { ok: true, json: async () => server.current };
  };
  const context = {
    document: { documentElement: { lang: 'fr' }, getElementById: id => elements[id] },
    window: { addEventListener: (name, listener) => windowEvents.set(name, listener) },
    location: { search: existing ? '?lang=fr&id=' + ID : '?lang=fr' },
    crypto: { randomUUID: () => '33333333-3333-4333-8333-333333333333' },
    history: { replaceState: (_state, _unused, url) => historyUrls.push(url) },
    URLSearchParams, Object, Number, JSON, Error,
    fetch: fetchMock, confirm: () => false,
  };
  const source = readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8');
  vm.runInNewContext(source, context, { timeout: 1000 });
  return { elements, events, windowEvents, calls, server, historyUrls,
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); } };
}

test('browser creates a private workspace, saves only after server confirmation, and preserves hidden fields', async () => {
  const h = browserHarness();
  await h.settle();
  assert.equal(h.elements.save.disabled, false);
  h.elements.customer.value = 'Fictional client';
  h.elements.notes.value = 'Première version';
  h.events.get('editor:input')();
  await h.events.get('editor:submit')({ preventDefault() {} });
  assert.equal(h.server.current.revision, 1);
  assert.deepEqual(h.server.current.content, { currency: 'CAD', customer: { name: 'Fictional client' }, notes: 'Première version' });
  assert.deepEqual(h.historyUrls, ['/internal/editor?lang=fr&id=' + ID]);
  assert.match(h.elements.status.textContent, /Enregistré sur le serveur/);
  assert.equal(h.elements.save.disabled, true);
  // Revisions containing details not supported by this first editor must not be erased.
  h.server.current.content.customer.email = 'fictional@example.test';
  h.server.current.content.lines = [{ description: 'Existing item', quantity: 2 }];
  h.server.current.content.taxes = [{ code: 'TEST', rateMilliPercent: 100 }];
  const h2 = browserHarness({ existing: h.server.current });
  await h2.settle();
  h2.elements.notes.value = 'Edited note';
  h2.events.get('editor:input')();
  await h2.events.get('editor:submit')({ preventDefault() {} });
  assert.equal(h2.server.current.revision, 2);
  assert.equal(h2.server.current.content.customer.email, 'fictional@example.test');
  assert.deepEqual(h2.server.current.content.lines, [{ description: 'Existing item', quantity: 2 }]);
  assert.deepEqual(h2.server.current.content.taxes, [{ code: 'TEST', rateMilliPercent: 100 }]);
  assert.equal(h2.server.current.content.notes, 'Edited note');
  const write = h2.calls.find(item => item.options.method === 'PUT');
  assert.equal(write.options.headers['X-Facturations-CSRF'], csrfToken);
  assert.equal(write.options.credentials, 'same-origin');
});

test('a revision conflict keeps typed changes and does not claim success', async () => {
  const initial = { id: ID, revision: 1, content: { currency: 'CAD', customer: { name: 'Test' }, notes: 'Before' },
    status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
  const h = browserHarness({ existing: initial });
  await h.settle();
  h.elements.notes.value = 'Unsent change';
  h.events.get('editor:input')();
  h.server.conflict = true;
  await h.events.get('editor:submit')({ preventDefault() {} });
  assert.equal(h.server.current.revision, 1);
  assert.equal(h.elements.notes.value, 'Unsent change');
  assert.match(h.elements.status.textContent, /Conflit de révision/);
  assert.equal(h.elements.save.disabled, false);
  const leave = { preventDefault() {}, returnValue: null };
  h.windowEvents.get('beforeunload')(leave);
  assert.equal(leave.returnValue, '');
});
