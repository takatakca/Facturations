'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserWorkspaceEditor, renderEditor } = require('../src/browser-workspace-editor');
const { COOKIE_NAME } = require('../src/staff-session-cookie');
const { previewDraft } = require('../src/draft-preview');

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
  attachBrowserWorkspaceEditor(server, { origin: 'https://fictional.example.test', staffAuthStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run({ base: `http://127.0.0.1:${server.address().port}`, state }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('editor and script require current staff cookie, never accept admin or bearer headers', async () => {
  await withServer(async ({ base, state }) => {
    for (const path of ['/internal/editor?lang=fr&id=' + ID, '/internal/editor-client.js']) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie('Z'.repeat(43)) } })).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie(TOKEN), 'X-Admin-Key': 'fictional-internal' } })).status, 401);
      assert.equal((await fetch(base + path, { headers: { Cookie: cookie(TOKEN), Authorization: 'Bearer ' + TOKEN } })).status, 401);
      assert.equal((await fetch(base + path, { method: 'POST', headers: { Cookie: cookie(TOKEN) } })).status, 405);
    }
    state.role = 'VIEWER';
    assert.equal((await fetch(base + '/internal/editor', { headers: { Cookie: cookie(TOKEN) } })).status, 401);
    state.role = null;
    assert.equal((await fetch(base + '/internal/editor', { headers: { Cookie: cookie(TOKEN) } })).status, 401);
    state.role = 'STAFF'; state.unavailable = true;
    assert.equal((await fetch(base + '/internal/editor', { headers: { Cookie: cookie(TOKEN) } })).status, 503);
  });
});

test('FR/EN private HTML contains five accessible line rows, three optional tax rows and no credentials', async () => {
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
      assert.match(html, /id="email" type="email"/);
      assert.match(html, /id="invoiceDate" type="date"/);
      assert.match(html, /id="line-5-price"/);
      assert.match(html, /id="tax-3-rate"/);
      assert.match(html, /id="editing-fields" class="editing-fields" disabled/);
      assert.match(html, /id="preview"[^>]* hidden/);
      assert.match(html, /\/internal\/recent-workspaces\?lang=/);
      assert.doesNotMatch(html, new RegExp(TOKEN));
      assert.doesNotMatch(html, /fictional-internal|csrfToken|<script(?! src)/);
    }
    const script = await fetch(base + '/internal/editor-client.js', { headers: { Cookie: cookie(TOKEN) } });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
    assert.equal(script.headers.get('cache-control'), 'private, no-store');
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

// Actual browser JS under Node VM: synthetic cookie routes, no external services or storage.
function browserHarness({ existing = null } = {}) {
  const events = new Map();
  const windowEvents = new Map();
  // Keep the mock DOM in sync with the actual editor HTML, including preview and fieldset.
  const ids = ['editor', 'editing-fields', 'preview', 'customer', 'email', 'address', 'invoiceDate', 'dueDate',
    'notes', 'save', 'reload', 'status'];
  for (let n = 1; n <= 5; n++) for (const key of ['description', 'quantity', 'price', 'discount', 'taxable']) {
    ids.push(`line-${n}-${key}`);
  }
  for (let n = 1; n <= 3; n++) for (const key of ['code', 'label', 'rate']) ids.push(`tax-${n}-${key}`);
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: '', checked: false, disabled: true, hidden: true, href: '', dataset: {}, textContent: '',
    addEventListener(type, listener) { events.set(id + ':' + type, listener); },
  }]));
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
    URLSearchParams, Object, Number, JSON, Error, fetch: fetchMock, confirm: () => false,
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8'),
    context, { timeout: 1000 });
  return { elements, events, windowEvents, calls, server, historyUrls,
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); },
    submit: async () => events.get('editor:submit')({ preventDefault() {} }),
    edit: (id, value) => { elements[id].value = value; events.get('editor:input')(); },
  };
}

test('browser saves complete fictional line, explicit tax, contact and dates; server computes preview', async () => {
  const h = browserHarness(); await h.settle();
  assert.equal(h.elements.save.disabled, false);
  h.edit('customer', 'Fictional client');
  h.edit('email', 'fictional@example.test');
  h.edit('address', '123 Example Street');
  h.edit('invoiceDate', '2026-09-21');
  h.edit('dueDate', '2026-10-21');
  h.edit('notes', 'Synthetic notes');
  h.edit('line-1-description', 'Synthetic service');
  h.edit('line-1-quantity', '2');
  h.edit('line-1-price', '12,50');
  h.edit('line-1-discount', '1.00');
  h.elements['line-1-taxable'].checked = true;
  h.events.get('editor:change')();
  h.edit('tax-1-code', 'test');
  h.edit('tax-1-label', 'Example tax');
  h.edit('tax-1-rate', '9,975');
  await h.submit();
  assert.equal(h.server.current.revision, 1);
  assert.equal(h.server.current.content.customer.email, 'fictional@example.test');
  assert.deepEqual(h.server.current.content.lines, [{ description: 'Synthetic service', quantity: 2,
    unitPriceCents: 1250, discountCents: 100, taxable: true }]);
  assert.deepEqual(h.server.current.content.taxes, [{ code: 'TEST', label: 'Example tax', rateMilliPercent: 9975 }]);
  assert.equal(previewDraft(h.server.current.content).subtotalCents, 2400);
  assert.equal(previewDraft(h.server.current.content).taxTotalCents, 239);
  assert.equal(h.server.current.content.dueDate, '2026-10-21');
  assert.deepEqual(h.historyUrls, ['/internal/editor?lang=fr&id=' + ID]);
  assert.match(h.elements.status.textContent, /Enregistré sur le serveur/);
  assert.equal(h.elements.save.disabled, true);
  assert.equal(h.elements.preview.hidden, false);
  assert.equal(h.elements.preview.href, '/internal/workspaces/' + ID + '/preview?lang=fr');
  const write = h.calls.find(item => item.options.method === 'POST');
  assert.equal(write.options.headers['X-Facturations-CSRF'], csrfToken);
  assert.equal(write.options.credentials, 'same-origin');
  assert.equal(write.options.headers.Accept, 'application/json');
});

test('reopen preserves metadata and explicit tax flags; a revision conflict does not discard edits', async () => {
  const initial = { id: ID, revision: 1, content: {
    currency: 'CAD', customer: { name: 'Test', email: 'test@example.test', address: 'Example' },
    invoiceDate: '2026-09-21', dueDate: '2026-10-21', notes: 'Before',
    lines: [{ description: 'Service', quantity: 2, unitPriceCents: 1550, discountCents: 0, taxable: false }],
    taxes: [{ code: 'TAX', label: 'Example', rateMilliPercent: 1000 }],
  }, status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
  const h = browserHarness({ existing: initial }); await h.settle();
  assert.equal(h.elements['line-1-price'].value, '15.50');
  assert.equal(h.elements['tax-1-rate'].value, '1.000');
  h.edit('notes', 'Edited note');
  await h.submit();
  assert.equal(h.server.current.revision, 2);
  assert.equal(h.server.current.content.customer.address, 'Example');
  assert.equal(h.server.current.content.lines[0].taxable, false);
  assert.equal(h.server.current.content.taxes[0].rateMilliPercent, 1000);
  h.edit('line-1-price', '20.00'); h.server.conflict = true;
  await h.submit();
  assert.equal(h.server.current.revision, 2);
  assert.equal(h.elements['line-1-price'].value, '20.00');
  assert.match(h.elements.status.textContent, /Conflit de révision/);
  assert.equal(h.elements.save.disabled, false);
  assert.equal(h.elements.preview.hidden, true);
  const leave = { preventDefault() {}, returnValue: null };
  h.windowEvents.get('beforeunload')(leave);
  assert.equal(leave.returnValue, '');
});

test('invalid amounts, tax rates, discounts and due dates never reach the write route', async () => {
  const h = browserHarness(); await h.settle();
  h.edit('line-1-description', 'Example');
  h.edit('line-1-quantity', '1');
  h.edit('line-1-price', '10.001');
  await h.submit();
  assert.match(h.elements.status.textContent, /Vérifiez les champs/);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  h.edit('line-1-price', '10.00'); h.edit('line-1-discount', '11.00');
  await h.submit();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  h.edit('line-1-discount', '0.00'); h.edit('tax-1-code', 'TAX');
  h.edit('tax-1-label', 'Example'); h.edit('tax-1-rate', '101');
  await h.submit();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  h.edit('tax-1-rate', '5.000'); h.edit('invoiceDate', '2026-10-21');
  h.edit('dueDate', '2026-09-21'); await h.submit();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('more than five existing lines fails closed instead of silently erasing them', async () => {
  const initial = { id: ID, revision: 3, status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false,
    content: { currency: 'CAD', customer: { name: 'Example' },
      lines: Array.from({ length: 6 }, () => ({ description: 'item', quantity: 1,
        unitPriceCents: 100, discountCents: 0, taxable: false })) } };
  const h = browserHarness({ existing: initial }); await h.settle();
  assert.equal(h.elements.save.disabled, true);
  assert.match(h.elements.status.textContent, /ne peut pas être édité/);
  h.edit('customer', 'Changed'); await h.submit();
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 0);
});
