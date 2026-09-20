'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDraftStore, StoreError } = require('../src/draft-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const makeDraft = () => ({
  currency: 'CAD',
  customer: { name: 'Example fictional customer', email: 'fictional@example.test' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20',
  lines: [{ description: 'Example service', quantity: 1, unitPriceCents: 2599, taxable: false }],
  taxes: [],
});

test('real disposable PostgreSQL: durable drafts, same-key retries and tenant isolation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const businessId = 'test-' + crypto.randomUUID();
    const key = crypto.randomUUID().replace(/-/g, '');
    try {
      const store = createDraftStore({ pool, businessId });
      const [first, retry] = await Promise.all([
        store.createDraft(makeDraft(), key),
        store.createDraft(makeDraft(), key),
      ]);
      assert.equal(first.id, retry.id);
      assert.equal(first.status, 'DRAFT');
      assert.equal(first.preview.totalCents, 2599);
      assert.equal(first.preview.persisted, true);
      const found = await store.getDraft(first.id);
      assert.equal(found.id, first.id);
      assert.equal(found.preview.customer.email, 'fictional@example.test');
      const audit = await pool.query(
        'SELECT count(*)::integer AS count FROM invoice_audit_events WHERE business_id=$1 AND draft_id=$2',
        [businessId, first.id]
      );
      assert.equal(audit.rows[0].count, 1);
      const different = makeDraft(); different.lines[0].unitPriceCents = 2600;
      await assert.rejects(store.createDraft(different, key),
        error => error instanceof StoreError && error.code === 'IDEMPOTENCY_CONFLICT');
      const foreign = createDraftStore({ pool, businessId: 'foreign-' + crypto.randomUUID() });
      await assert.rejects(foreign.getDraft(first.id),
        error => error instanceof StoreError && error.code === 'DRAFT_NOT_FOUND');
      const count = await pool.query('SELECT count(*)::integer AS count FROM invoice_drafts WHERE business_id=$1', [businessId]);
      assert.equal(count.rows[0].count, 1);
    } finally {
      await pool.end();
    }
  });
