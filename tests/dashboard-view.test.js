'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { renderDashboard, escapeHtml, money } = require('../src/dashboard-view');
const { createServer } = require('../src/server');

const TOKEN = 'T'.repeat(43); // Fictional fixture, NOT a real credential.
const TENANT = 'fictional-company';
const ID = '11111111-1111-4111-8111-111111111111';
const summary = Object.freeze({
  status: 'DRAFTS_ONLY', draftCount: '1', customerCount: '1', draftTotalCents: '2599',
  revenueAvailable: false, issuedInvoicesAvailable: false, paymentsAvailable: false,
});
const drafts = Object.freeze({ status: 'DRAFTS_ONLY', drafts: [
  { id: ID, customerName: '<img src=x onerror=alert(1)> & "customer"',
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', totalCents: '2599', currency: 'CAD', status: 'DRAFT' },
] });

const auth = { async getSession(token) {
  return token === TOKEN ? { id: ID, businessId: TENANT, role: 'OWNER' } : null;
} };

async function withServer(run) {
  const calls = { summary: 0, drafts: 0 };
  const server = createServer({
    config: { businessId: TENANT, adminKey: 'synthetic-admin-key', waveToken: null },
    staffAuthStore: auth,
    dashboardStore: {
      async getSummary() { calls.summary++; return summary; },
      async listDrafts() { calls.drafts++; return drafts; },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('renderer escapes attacker-controlled names and prints draft-only amounts in both languages', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(money('2599', 'fr'), '25,99\u00a0$ CA');
  assert.equal(money('2599', 'en'), 'CA$25.99');
  for (const language of ['fr', 'en']) {
    const page = renderDashboard({ summary, drafts, language });
    assert.match(page, new RegExp(`<html lang="${language}"`));
    assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;customer&quot;'));
    assert.ok(!page.includes('<img src=x onerror=alert(1)>'));
    assert.ok(!page.includes('<script'));
    assert.ok(!page.includes('<form'));
    assert.ok(!page.includes('synthetic-admin-key'));
    assert.ok(!page.includes(TOKEN));
    assert.match(page, /Drafts only|Brouillons seulement/);
  }
  assert.match(renderDashboard({ summary, drafts, language: 'fr' }), /ne sont ni des revenus/);
  assert.match(renderDashboard({ summary, drafts, language: 'en' }), /not revenue or payments/);
});

test('renderer fails closed on unsupported data and handles empty drafts', () => {
  assert.throws(() => renderDashboard({ summary: {}, drafts }), TypeError);
  assert.throws(() => renderDashboard({ summary, drafts: {} }), TypeError);
  assert.throws(() => renderDashboard({ summary, drafts, language: 'es' }), TypeError);
  assert.throws(() => renderDashboard({ summary, drafts: { status: 'DRAFTS_ONLY', drafts: [
    { ...drafts.drafts[0], status: 'ISSUED' },
  ] } }), TypeError);
  assert.match(renderDashboard({ summary, drafts: { status: 'DRAFTS_ONLY', drafts: [] } }), /Aucun brouillon/);
  assert.equal(money('not-a-number', 'fr'), '—');
});

test('HTML endpoint denies unauthenticated and admin-key requests before accessing data', async () => {
  await withServer(async (base, calls) => {
    for (const headers of [{}, { 'X-Admin-Key': 'synthetic-admin-key' },
      { Authorization: 'Bearer invalid', 'X-Admin-Key': 'synthetic-admin-key' }]) {
      const response = await fetch(base + '/internal/dashboard', { headers });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    }
    assert.deepEqual(calls, { summary: 0, drafts: 0 });
  });
});

test('HTML endpoint requires a live staff session, bounds query and locks down browser headers', async () => {
  await withServer(async (base, calls) => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    for (const path of ['/internal/dashboard?lang=es', '/internal/dashboard?lang=en&lang=fr',
      '/internal/dashboard?lang=fr&token=abc']) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 422);
    }
    assert.deepEqual(calls, { summary: 0, drafts: 0 });
    const response = await fetch(base + '/internal/dashboard?lang=en', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /Recent drafts/);
    assert.deepEqual(calls, { summary: 1, drafts: 1 });
    assert.equal((await fetch(base + '/internal/dashboard', { method: 'POST', headers })).status, 405);
  });
});
