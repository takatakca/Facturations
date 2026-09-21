'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { hasUnpairedSurrogate } = require('../src/unicode-validation');
const { previewDraft, DraftValidationError } = require('../src/draft-preview');
const { createDraftStore } = require('../src/draft-store');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');
const { createServer } = require('../src/server');

const draft = () => ({
  currency: 'CAD', customer: { name: 'Café Démo 😀', email: 'fictional@example.test' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Service 😀',
  lines: [{ description: 'Travaux 😀', quantity: 1, unitPriceCents: 2500, taxable: false }], taxes: [],
});
const bad = '\ud800';
const badLow = '\udc00';
const good = '\ud83d\ude00';
const key = 'k'.repeat(64);

test('valid supplementary pairs survive; lone surrogates fail each invoice text field', () => {
  assert.equal(hasUnpairedSurrogate('Café 😀'), false);
  assert.equal(hasUnpairedSurrogate(good), false);
  assert.equal(hasUnpairedSurrogate(bad), true);
  assert.equal(hasUnpairedSurrogate(badLow), true);
  assert.equal(hasUnpairedSurrogate(bad + good), true);
  assert.equal(hasUnpairedSurrogate(good + badLow), true);
  assert.equal(previewDraft(draft()).customer.name, 'Café Démo 😀');
  for (const [change, code] of [
    [d => { d.customer.name = 'Café ' + bad; }, 'INVALID_CUSTOMER_NAME'],
    [d => { d.customer.email = 'demo' + badLow + '@example.test'; }, 'INVALID_CUSTOMER_EMAIL'],
    [d => { d.customer.address = 'Rue ' + bad; }, 'INVALID_CUSTOMER_ADDRESS'],
    [d => { d.notes = 'Note ' + badLow; }, 'INVALID_NOTES'],
    [d => { d.lines[0].description = 'Travaux ' + bad; }, 'INVALID_DESCRIPTION'],
    [d => { d.taxes = [{ code: 'TEST', label: 'Taxe ' + bad, rateMilliPercent: 0 }]; }, 'INVALID_TAX_LABEL'],
  ]) {
    const value = draft(); change(value);
    assert.throws(() => previewDraft(value),
      error => error instanceof DraftValidationError && error.code === code && error.statusCode === 422);
  }
});

test('workspace rejects nested lone surrogates before connecting; valid paired emoji accepted', async () => {
  const pool = { connect() { throw new Error('no connection expected'); }, query() {} };
  const store = createDraftWorkspaceStore({ pool, businessId: 'synthetic-unicode' });
  const token = 'A'.repeat(43);
  const creationKey = 'synthetic-unicode-key-123';
  for (const invalid of [{ notes: bad }, { customer: { name: 'Café ' + badLow } },
    { lines: [{ description: bad }] }]) {
    await assert.rejects(store.create({ token, creationKey, content: invalid }),
      error => error instanceof WorkspaceError && error.code === 'INVALID_WORKSPACE_CONTENT' && error.statusCode === 422);
    await assert.rejects(store.save({ token, workspaceId: crypto.randomUUID(), expectedRevision: 1, content: invalid }),
      error => error instanceof WorkspaceError && error.code === 'INVALID_WORKSPACE_CONTENT' && error.statusCode === 422);
  }
});

test('HTTP preview rejects escaped lone surrogates with 422, not a storage failure', async () => {
  const server = createServer({ config: { adminKey: key } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const invalid = draft(); invalid.customer.name = 'Café ' + bad;
    const response = await fetch(base + '/api/drafts/preview', {
      method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'INVALID_CUSTOMER_NAME' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('disposable PostgreSQL accepts paired emoji in invoice snapshots and workspace revisions',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const businessId = 'unicode-' + crypto.randomUUID();
    try {
      const draftStore = createDraftStore({ pool, businessId });
      const saved = await draftStore.createDraft(draft(), crypto.randomUUID().replace(/-/g, ''));
      assert.equal((await draftStore.getDraft(saved.id)).preview.customer.name, 'Café Démo 😀');
      const staff = await pool.query(
        `INSERT INTO facturations_staff_users
           (business_id,email_normalized,role,password_salt,password_hash,email_verified_at)
         VALUES ($1,$2,'STAFF',$3,$4,now()) RETURNING id`,
        [businessId, crypto.randomUUID() + '@example.test', Buffer.alloc(16), Buffer.alloc(64)]);
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO facturations_staff_sessions (business_id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,now()+interval '12 hours')`,
        [businessId, staff.rows[0].id, crypto.createHash('sha256').update(token).digest()]);
      const workspaceStore = createDraftWorkspaceStore({ pool, businessId });
      const workspace = await workspaceStore.create({ token, creationKey: crypto.randomUUID().replace(/-/g, ''),
        content: { notes: 'Café 😀' } });
      const updated = await workspaceStore.save({ token, workspaceId: workspace.id,
        expectedRevision: 1, content: { customer: { name: 'Café 😀' } } });
      assert.equal(updated.revision, 2);
      assert.equal((await workspaceStore.load({ token, workspaceId: workspace.id })).content.customer.name, 'Café 😀');
      const history = await pool.query(
        'SELECT content FROM facturations_draft_workspace_revisions WHERE business_id=$1 AND workspace_id=$2 ORDER BY revision',
        [businessId, workspace.id]);
      assert.deepEqual(history.rows.map(row => row.content), [{ notes: 'Café 😀' }, { customer: { name: 'Café 😀' } }]);
    } finally { await pool.end(); }
  });
