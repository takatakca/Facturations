'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { renderEditor } = require('../src/browser-workspace-editor');

const ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'D'.repeat(43);
const saved = revision => ({ id: ID, revision,
  content: { currency: 'CAD', customer: { name: 'Fictional', email: 'fictional@example.test' },
    notes: 'Synthetic only', lines: [], taxes: [] },
  status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false });

function harness({ existing = false, loadDeferred = false } = {}) {
  const ids = ['editor', 'editing-fields', 'preview', 'customer', 'email', 'address', 'invoiceDate',
    'dueDate', 'notes', 'save', 'reload', 'status'];
  for (let n = 1; n <= 5; n++) for (const field of ['description', 'quantity', 'price', 'discount', 'taxable']) {
    ids.push(`line-${n}-${field}`);
  }
  for (let n = 1; n <= 3; n++) for (const field of ['code', 'label', 'rate']) ids.push(`tax-${n}-${field}`);
  const listeners = new Map();
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: '', checked: false, disabled: true, hidden: true, href: '', textContent: '', dataset: {},
    addEventListener(name, callback) { listeners.set(id + ':' + name, callback); },
  }]));
  const calls = [];
  const pendingGets = [];
  const server = { current: existing ? saved(1) : null, failWrite: false };
  const fetchMock = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/internal/workspaces/csrf') return { ok: true, json: async () => ({ csrfToken: TOKEN }) };
    if (path === '/internal/workspaces/' + ID && (!options.method || options.method === 'GET')) {
      if (loadDeferred) return new Promise(resolve => pendingGets.push(resolve));
      return { ok: true, json: async () => server.current };
    }
    if (server.failWrite) return { ok: false, status: 409 };
    if (path !== '/internal/workspaces' && path !== '/internal/workspaces/' + ID) {
      throw new Error('Unexpected private route');
    }
    const request = JSON.parse(options.body);
    if (path === '/internal/workspaces') {
      assert.match(request.creationKey, /^[a-f0-9]{32}$/);
      server.current = { ...saved(1), content: request.content };
    } else {
      assert.equal(request.expectedRevision, server.current.revision);
      server.current = { ...saved(server.current.revision + 1), content: request.content };
    }
    return { ok: true, json: async () => server.current };
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8'), {
    document: { documentElement: { lang: 'fr' }, getElementById: id => elements[id] },
    window: { addEventListener() {} }, location: { search: existing ? '?lang=fr&id=' + ID : '?lang=fr' },
    crypto: { randomUUID: () => '33333333-3333-4333-8333-333333333333' },
    history: { replaceState() {} }, URLSearchParams, Object, Number, JSON, Error,
    fetch: fetchMock, confirm: () => true, // Explicitly consent to discard simulated unsaved input on retry.
  }, { timeout: 1000 });
  return { elements, listeners, calls, server, pendingGets,
    settle: async () => { await new Promise(setImmediate); await new Promise(setImmediate); },
    edit: (id, value) => { elements[id].value = value; listeners.get('editor:input')(); },
    submit: async () => listeners.get('editor:submit')({ preventDefault() {} }),
  };
}

test('FR/EN editor has initially hidden preview, disabled fieldset and no prefilled tax assumptions', () => {
  for (const lang of ['fr', 'en']) {
    const html = renderEditor(lang, ID);
    assert.match(html, /<fieldset id="editing-fields" class="editing-fields" disabled>/);
    assert.match(html, /<a id="preview"[^>]* hidden>/);
    assert.match(html, /#preview\[hidden\]\{display:none!important\}/);
    assert.match(html, /\/internal\/editor-client\.js/);
    assert.doesNotMatch(html, /9975|9\.975|X-Admin-Key|D{43}/);
    assert.match(html, lang === 'fr' ? /Aperçu calculé de la version enregistrée/ : /Calculated preview of saved version/);
  }
});

test('new draft unlocks only after CSRF; saved preview appears after POST and disappears on edits or 409', async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.elements['editing-fields'].disabled, false);
  assert.equal(h.elements.preview.hidden, true);
  h.edit('customer', 'Fictional client');
  assert.equal(h.elements.preview.hidden, true);
  await h.submit();
  assert.equal(h.server.current.revision, 1);
  assert.equal(h.elements.preview.hidden, false);
  assert.equal(h.elements.preview.href, '/internal/workspaces/' + ID + '/preview?lang=fr');
  h.edit('notes', 'Changed, not saved');
  assert.equal(h.elements.preview.hidden, true, 'never present a stale preview as the current edits');
  h.server.failWrite = true;
  await h.submit();
  assert.equal(h.elements.preview.hidden, true);
  assert.equal(h.elements.notes.value, 'Changed, not saved');
  assert.match(h.elements.status.textContent, /Conflit de révision/);
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('pending initial GET disables the whole fieldset; failed GET cannot accidentally write revision null', async () => {
  const h = harness({ existing: true, loadDeferred: true });
  await h.settle();
  assert.equal(h.pendingGets.length, 1);
  assert.equal(h.elements['editing-fields'].disabled, true);
  assert.equal(h.elements.save.disabled, true);
  assert.equal(h.elements.preview.hidden, true);
  h.pendingGets.shift()({ ok: false, status: 503 });
  await h.settle();
  assert.equal(h.elements['editing-fields'].disabled, true, 'unknown revision stays read-only');
  assert.equal(h.elements.reload.disabled, false, 'allow retry after a temporary failure');
  h.edit('customer', 'Programmatic edit while disabled');
  await h.submit();
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 0);
  await h.listeners.get('reload:click')();
  assert.equal(h.pendingGets.length, 1);
  h.pendingGets.shift()({ ok: true, json: async () => saved(1) });
  await h.settle();
  assert.equal(h.elements['editing-fields'].disabled, false);
  assert.equal(h.elements.preview.hidden, false);
  assert.equal(h.elements.customer.value, 'Fictional');
  assert.equal(h.elements.preview.href, '/internal/workspaces/' + ID + '/preview?lang=fr');
});

test('reloading a saved draft hides preview while GET is pending, restores it only on valid success', async () => {
  const h = harness({ existing: true, loadDeferred: true });
  await h.settle();
  h.pendingGets.shift()({ ok: true, json: async () => saved(1) });
  await h.settle();
  assert.equal(h.elements.preview.hidden, false);
  const reloadPromise = h.listeners.get('reload:click')();
  assert.equal(h.elements.preview.hidden, true);
  assert.equal(h.elements['editing-fields'].disabled, true);
  h.pendingGets.shift()({ ok: true, json: async () => saved(2) });
  await reloadPromise;
  assert.equal(h.elements['editing-fields'].disabled, false);
  assert.equal(h.elements.preview.hidden, false);
  assert.match(h.elements.status.textContent, /Révision 2/);
});
