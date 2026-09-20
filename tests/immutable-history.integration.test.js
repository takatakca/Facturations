'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDraftStore } = require('../src/draft-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const sample = () => ({
  currency: 'CAD', customer: { name: 'Fictional Person', email: 'immutable@example.test' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20',
  lines: [{ description: 'Example service', quantity: 1, unitPriceCents: 2500, taxable: false }],
  taxes: [],
});

async function immutable(pool, sql, values, message) {
  await assert.rejects(pool.query(sql, values), error =>
    error.code === '23514' && error.message.includes(message));
}

test('disposable PostgreSQL rejects audit rewrites/deletion and draft snapshot mutation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'immutable-' + crypto.randomUUID();
    try {
      const draft = await createDraftStore({ pool, businessId: tenant })
        .createDraft(sample(), crypto.randomUUID().replace(/-/g, ''));
      const event = await pool.query(
        'SELECT id FROM invoice_audit_events WHERE business_id=$1 AND draft_id=$2',
        [tenant, draft.id]);
      assert.equal(event.rows.length, 1);
      const eventId = event.rows[0].id;

      await immutable(pool,
        "UPDATE invoice_drafts SET snapshot=jsonb_set(snapshot,'{notes}','\"tampered\"') WHERE business_id=$1 AND id=$2",
        [tenant, draft.id], 'snapshot and identity are immutable');
      await immutable(pool,
        'UPDATE invoice_drafts SET business_id=$3 WHERE business_id=$1 AND id=$2',
        [tenant, draft.id, 'other-' + tenant], 'snapshot and identity are immutable');
      await immutable(pool,
        'DELETE FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [tenant, draft.id], 'drafts cannot be deleted');
      await immutable(pool,
        'UPDATE invoice_audit_events SET action=$2 WHERE id=$1',
        [eventId, 'DRAFT_CREATED'], 'audit events are immutable');
      await immutable(pool,
        'DELETE FROM invoice_audit_events WHERE id=$1',
        [eventId], 'audit events are immutable');

      const after = await pool.query(
        'SELECT business_id,snapshot FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [tenant, draft.id]);
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].snapshot.customer.email, 'immutable@example.test');
      assert.equal(after.rows[0].snapshot.notes, null);
      const audit = await pool.query('SELECT count(*)::integer AS n FROM invoice_audit_events WHERE id=$1', [eventId]);
      assert.equal(audit.rows[0].n, 1);

      // Non-financial bookkeeping field updates remain possible for later workflows.
      const allowed = await pool.query(
        'UPDATE invoice_drafts SET updated_at=updated_at + interval \'1 second\' WHERE business_id=$1 AND id=$2 RETURNING id',
        [tenant, draft.id]);
      assert.equal(allowed.rows[0].id, draft.id);
    } finally {
      await pool.end();
    }
  });
