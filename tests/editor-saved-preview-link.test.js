'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ID = '22222222-2222-4222-8222-222222222222';
const script = readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8');

function harness({ language = 'fr', existing = null, denied = false } = {}) {
  const handlers = new Map();
  let link;
  const elements = {};
  const ids = ['editor', 'customer', 'email', 'address', 'invoiceDate', 'dueDate',
    'notes', 'save', 'reload', 'status'];
  for (let n = 1; n <= 5; n++) {
    for (const key of ['description', 'quantity', 'price', 'discount', 'taxable']) ids.push(`line-${n}-${key}`);
  }
  for (let n = 1; n <= 3; n++) {
    for (const key of ['code', 'label', 'rate']) ids.push(`tax-${n}-${key}`);
  }
  for (const id of ids) elements[id] = {
    value: '', checked: false, disabled: true, dataset: {}, textContent: '',
    addEventListener(name, fn) { handlers.set(id + ':' + name, fn); },
  };
  elements.editor.querySelector = selector => {
    assert.equal(selector, '.actions');
    return { append(node) { link = node; } };
  };
  const calls = [];
  const stored = existing || { id: ID, revision: 1, content: { currency: 'CAD', customer: {},
    notes: '', lines: [], taxes: [] }, status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
  const mockFetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/internal/workspaces/csrf') {
      return { ok: true, json: async () => ({ csrfToken: 'D'.repeat(43) }) };
    }
    if (path === '/internal/workspaces/' + ID && !options.method) {
      return denied ? { ok: false, status: 404 } : { ok: true, json: async () => stored };
    }
    if (path === '/internal/workspaces' && options.method === 'POST') {
      return { ok: true, json: async () => ({ ...stored, content: JSON.parse(options.body).content }) };
    }
    throw new Error('Unexpected synthetic request: ' + path);
  };
  const context = {
    document: {
      documentElement: { lang: language },
      getElementById: id => elements[id],
      createElement(tag) {
        assert.equal(tag, 'a');
        return { hidden: false, href: undefined, setAttribute(name, value) {
          assert.equal(name, 'aria-label'); this.ariaLabel = value;
        } };
      },
    },
    window: { addEventListener() {} },
    location: { search: existing ? '?lang=' + language + '&id=' + ID : '?lang=' + language },
    crypto: { randomUUID: () => '33333333-3333-4333-8333-333333333333' },
    history: { replaceState() {} },
    URLSearchParams, Object, Number, JSON, Date, Error, fetch: mockFetch, confirm: () => false,
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { elements, handlers, calls, get link() { return link; },
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); },
    submit: async () => handlers.get('editor:submit')({ preventDefault() {} }),
  };
}

test('new FR/EN workspace shows no preview locator before save, then links to saved UUID', async () => {
  for (const language of ['fr', 'en']) {
    const h = harness({ language });
    assert.equal(h.link.hidden, true);
    assert.equal(h.link.href, undefined);
    await h.settle();
    assert.equal(h.link.hidden, true);
    assert.equal(h.link.href, undefined);
    h.elements.customer.value = 'Fictional customer';
    h.handlers.get('editor:input')();
    assert.equal(h.link.hidden, true);
    await h.submit();
    assert.equal(h.link.hidden, false);
    assert.equal(h.link.href, `/internal/workspaces/${ID}/preview?lang=${language}`);
    assert.match(h.link.textContent, language === 'fr' ? /version enregistrée/ : /saved version/);
    assert.equal(h.link.ariaLabel, h.link.textContent);
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
    h.elements.notes.value = 'Unsaved work';
    h.handlers.get('editor:input')();
    assert.equal(h.link.href, `/internal/workspaces/${ID}/preview?lang=${language}`);
    assert.equal(h.link.hidden, false); // Label explicitly refers to the SAVED version, not unsaved edits.
  }
});

test('existing workspace shortcut remains hidden until a successful authenticated reload', async () => {
  const allowed = harness({ existing: { id: ID, revision: 2, content: { currency: 'CAD',
    customer: {}, notes: '', lines: [], taxes: [] }, status: 'WORK_IN_PROGRESS',
    invoiceIssued: false, emailed: false } });
  assert.equal(allowed.link.hidden, true);
  await allowed.settle();
  assert.equal(allowed.link.hidden, false);
  assert.equal(allowed.link.href, `/internal/workspaces/${ID}/preview?lang=fr`);
  const forbidden = harness({ existing: true, denied: true });
  await forbidden.settle();
  assert.equal(forbidden.link.hidden, true);
  assert.equal(forbidden.link.href, undefined);
  assert.equal(forbidden.calls.filter(call => call.options.method === 'POST').length, 0);
});
