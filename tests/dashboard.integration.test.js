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

test('disposable PostgreSQL: dashboard lists only tenant drafts and counts only tenant customers',
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
      await b.createDraft(example('other@example.test', 999999), crypto.randomUUID().replace(/-/g, ''));
      const dashboardA = createDashboardStore({ pool, businessId: first });
      const dashboardB = createDashboardStore({ pool, businessId: second });
      const summaryA = await dashboardA.getSummary();
      assert.deepEqual([summaryA.draftCount, summaryA.customerCount, summaryA.draftTotalCents], ['2', '2', '5000']);
      assert.equal(summaryA.revenueAvailable, false);
      assert.equal((await dashboardB.getSummary()).draftTotalCents, '999999');
      const listing = await dashboardA.listDrafts(pageOptions('1', '1'));
      assert.equal(listing.pageSize, 1);
      assert.equal(listing.drafts.length, 1);
      const full = await dashboardA.listDrafts(pageOptions('1', '20'));
      assert.deepEqual(new Set(full.drafts.map(d => d.id)), new Set([idA1.id, idA2.id]));
      assert.equal(full.drafts.every(d => d.status === 'DRAFT' && d.currency === 'CAD'), true);
      assert.equal(JSON.stringify(full).includes('other@example.test'), false);
      assert.equal(JSON.stringify(full).includes('first@example.test'), false);
      assert.deepEqual((await dashboardA.listDrafts(pageOptions('2', '20'))).drafts, []);
    } finally { await pool.end(); }
  });
