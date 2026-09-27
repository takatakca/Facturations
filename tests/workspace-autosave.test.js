'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ID = '22222222-2222-4222-8222-222222222222';
const CSRF = 'D'.repeat(43);
const SCRIPT = readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8');

function harness() {
  const events = new Map();
  const windowEvents = new Map();
  const ids = ['editor', 'editing-fields', 'preview', 'customer', 'email', 'address',
    'invoiceDate', 'dueDate', 'notes', 'save', 'reload', 'status'];
  for (let n = 1; n <= 5; n++) for (const key of ['description', 'quantity', 'price', 'discount', 'taxable']) {
    ids.push(`line-${n}-${key}`);
  }
  for (let n = 1; n <= 3; n++) for (const key of ['code', 'label', 'rate']) ids.push(`tax-${n}-${key}`);
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: '', checked: false, disabled: true, hidden: true, dataset: {}, href: '', textContent: '',
    addEventListener(type, callback) { events.set(id + ':' + type, callback); },
  }]));
  const writes = [];
  const state = { row: null, error: null };
  const timers = new Map();
  let currentTime = 0;
  let nextTimer = 1;
  const setTimer = (callback, delay) => {
    const handle = nextTimer++;
    timers.set(handle, { callback, at: currentTime + delay });
    return handle;
  };
  const cancelTimer = handle => { timers.delete(handle); };
  const advance = async duration => {
    currentTime += duration;
    for (;;) {
      const due = [...timers].find(([, timer]) => timer.at <= currentTime);
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
  };
  async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  }
  const fetchMock = async (path, options = {}) => {
    if (path === '/internal/workspaces/csrf') return { ok: true, json: async () => ({ csrfToken: CSRF }) };
    if (path === '/internal/workspaces/' + ID && !options.method) {
      return state.row ? { ok: true, json: async () => state.row } : { ok: false, status: 404 };
    }
    if (path !== '/internal/workspaces' && path !== '/internal/workspaces/' + ID) throw Error('Unexpected path');
    writes.push({ path, options });
    if (state.error) return { ok: false, status: state.error };
    const body = JSON.parse(options.body);
    if (path === '/internal/workspaces') {
      assert.match(body.creationKey, /^[a-f0-9]{32}$/);
      state.row = { id: ID, revision: 1, content: body.content,
        status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
    } else {
      assert.equal(body.expectedRevision, state.row.revision);
      state.row = { ...state.row, revision: state.row.revision + 1, content: body.content };
    }
    return { ok: true, json: async () => state.row };
  };
  elements.editor.requestSubmit = () => events.get('editor:submit')({ preventDefault() {} });
  const context = {
    document: { documentElement: { lang: 'fr' }, getElementById: id => elements[id] },
    window: { addEventListener: (type, callback) => windowEvents.set(type, callback) },
    location: { search: '?lang=fr' },
    crypto: { randomUUID: () => '33333333-3333-4333-8333-333333333333' },
    history: { replaceState() {} },
    URLSearchParams, Object, Number, JSON, Error, fetch: fetchMock,
    setTimeout: setTimer, clearTimeout: cancelTimer, confirm: () => true,
  };
  vm.runInNewContext(SCRIPT, context, { timeout: 1000 });
  return { elements, events, windowEvents, state, writes, timers, advance, settle,
    edit: (id, value) => { elements[id].value = value; events.get('editor:input')(); },
    manual: async () => { await elements.editor.requestSubmit(); await settle(); },
  };
}

test('debounces genuine edits, creates once and updates existing revision without browser storage', async () => {
  const h = harness(); await h.settle();
  assert.equal(h.writes.length, 0, 'Opening a blank page must not create empty drafts');
  h.edit('customer', 'Fictional customer');
  await h.advance(2000);
  h.edit('notes', 'First note');
  await h.advance(2999);
  assert.equal(h.writes.length, 0, 'Continuous typing must postpone the save');
  await h.advance(1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/internal/workspaces');
  assert.equal(h.writes[0].options.headers['X-Facturations-CSRF'], CSRF);
  assert.equal(h.writes[0].options.credentials, 'same-origin');
  assert.equal(h.state.row.revision, 1);
  assert.equal(h.state.row.content.customer.name, 'Fictional customer');
  assert.equal(h.elements.preview.hidden, false);
  assert.match(h.elements.status.textContent, /Enregistré sur le serveur/);
  h.edit('notes', 'Revised note');
  await h.advance(3000);
  assert.equal(h.writes.length, 2);
  assert.equal(JSON.parse(h.writes[1].options.body).expectedRevision, 1);
  assert.equal(h.state.row.revision, 2);
  assert.equal(h.state.row.content.notes, 'Revised note');
  assert.equal(h.elements.preview.hidden, false);
  h.edit('notes', 'Manual note');
  await h.manual();
  await h.advance(5000);
  assert.equal(h.writes.length, 3, 'Manual save must cancel any pending autosave');
  assert.equal(h.state.row.revision, 3);
});

test('incomplete line does not write; corrected input may then autosave', async () => {
  const h = harness(); await h.settle();
  h.edit('line-1-description', 'Incomplete fictitious service');
  await h.advance(3000);
  assert.equal(h.writes.length, 0);
  assert.equal(h.elements.save.disabled, false);
  assert.match(h.elements.status.textContent, /Vérifiez les champs/);
  h.edit('line-1-quantity', '2');
  h.edit('line-1-price', '12,50');
  await h.advance(3000);
  assert.equal(h.writes.length, 1);
  assert.equal(h.state.row.content.lines[0].unitPriceCents, 1250);
});

test('revision conflict pauses automatic writes and preserves unsaved edits for manual resolution', async () => {
  const h = harness(); await h.settle();
  h.edit('customer', 'Fictional customer'); await h.advance(3000);
  h.state.error = 409;
  h.edit('notes', 'Unsent change'); await h.advance(3000);
  assert.equal(h.writes.length, 2);
  assert.equal(h.state.row.revision, 1);
  assert.equal(h.elements.preview.hidden, true);
  assert.match(h.elements.status.textContent, /Conflit de révision/);
  h.edit('notes', 'Still unsent'); await h.advance(6000);
  assert.equal(h.writes.length, 2, 'Conflict must not silently retry after another keystroke');
  const unload = { preventDefault() {}, returnValue: null };
  h.windowEvents.get('beforeunload')(unload);
  assert.equal(unload.returnValue, '');
  h.state.error = null;
  await h.manual();
  assert.equal(h.writes.length, 3);
  assert.equal(h.state.row.content.notes, 'Still unsent');
  h.edit('notes', 'Auto resumes after explicit successful save'); await h.advance(3000);
  assert.equal(h.writes.length, 4);
});

test('outage pauses silent retry; pagehide cancels a pending timer without saving', async () => {
  const h = harness(); await h.settle();
  h.state.error = 503;
  h.edit('notes', 'Unsent notes'); await h.advance(3000);
  assert.equal(h.writes.length, 1);
  h.edit('notes', 'More unsent notes'); await h.advance(9000);
  assert.equal(h.writes.length, 1);
  assert.match(h.elements.status.textContent, /Modifications non enregistrées/);
  h.windowEvents.get('pagehide')();
  assert.equal(h.timers.size, 0);
  h.state.error = null;
  await h.manual();
  assert.equal(h.writes.length, 2);
  assert.equal(h.state.row.content.notes, 'More unsent notes');
});
