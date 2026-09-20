'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDraftStore } = require('../src/draft-store');
const { createDashboardStore, pageOptions } = require('../src/dashboard-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const example = (email, amount) => ({
  currency: 'CAD', customer: { name: 'Synthetic customer', email },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20',
  lines: [{ description: 'Synthetic service', quantity: 1, unitPriceCents: amount, taxable: false }],
  taxes: [],
});

test('disposable PostgreSQL: dashboard uses immutable draft customer names and keeps tenant data private',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const first = 'dashboard-a-' + crypto.randomUUID();
    const second = 'dashboard-b-' + crypto.randomUUID();
    try {
      const a = createDraftStore({ pool, businessId: first });
      const b = createDraftStore({ pool, businessId: second });
      const idA1 = await a.createDraft(example('first@example.test', 1999), crypto.randomUUID().replace(/-/g, ''));
      const idA2 = await a.createDraft(example('second@example.test', 3001), crypto.randomUUID().replace(/-/g, ''));
      // A subsequent draft for the same email contains a DIFFERENT recipient name.
      // The directory intentionally retains the original name (ON CONFLICT DO NOTHING);
      // the dashboard must not replace either historical snapshot name with that value.
      const renamed = example('first@example.test', 2500);
      renamed.customer.name = 'Updated fictional recipient';
      const idA3 = await a.createDraft(renamed, crypto.randomUUID().replace(/-/g, ''));
      await b.createDraft(example('other@example.test', 999999), crypto.randomUUID().replace(/-/g, ''));
      const directory = await pool.query(
        'SELECT name FROM invoice_customers WHERE business_id=$1 AND email_normalized=$2',
        [first, 'first@example.test']
      );
      assert.equal(directory.rows[0].name, 'Synthetic customer');
      const dashboardA = createDashboardStore({ pool, businessId: first });
      const dashboardB = createDashboardStore({ pool, businessId: second });
      const summaryA = await dashboardA.getSummary();
      assert.deepEqual([summaryA.draftCount, summaryA.customerCount, summaryA.draftTotalCents], ['3', '2', '7500']);
      assert.equal(summaryA.revenueAvailable, false);
      assert.equal((await dashboardB.getSummary()).draftTotalCents, '999999');
      const listing = await dashboardA.listDrafts(pageOptions('1', '1'));
      assert.equal(listing.pageSize, 1);
      assert.equal(listing.drafts.length, 1);
      const full = await dashboardA.listDrafts(pageOptions('1', '20'));
      assert.deepEqual(new Set(full.drafts.map(d => d.id)), new Set([idA1.id, idA2.id, idA3.id]));
      assert.equal(full.drafts.find(d => d.id === idA1.id).customerName, 'Synthetic customer');
      assert.equal(full.drafts.find(d => d.id === idA3.id).customerName, 'Updated fictional recipient');
      assert.equal(full.drafts.every(d => d.status === 'DRAFT' && d.currency === 'CAD'), true);
      assert.equal(JSON.stringify(full).includes('other@example.test'), false);
      assert.equal(JSON.stringify(full).includes('first@example.test'), false);
      assert.equal(JSON.stringify(full).includes('second@example.test'), false);
      assert.deepEqual((await dashboardA.listDrafts(pageOptions('2', '20'))).drafts, []);
    } finally { await pool.end(); }
  });
