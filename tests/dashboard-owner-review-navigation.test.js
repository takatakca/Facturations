'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { renderDashboard } = require('../src/dashboard-view');
const { createServer } = require('../src/server');

const TOKEN = 'R'.repeat(43);
const TENANT = 'fictional-owner-nav';
const summary = { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '0',
  draftTotalCents: '0', revenueAvailable: false, issuedInvoicesAvailable: false,
  paymentsAvailable: false };
const drafts = { status: 'DRAFTS_ONLY', drafts: [] };

async function withServer(browserOrigin, run) {
  const state = { role: 'OWNER', tenant: TENANT };
  const server = createServer({ config: {
    businessId: TENANT, browserOrigin, adminKey: 'synthetic-admin-nav-key', waveToken: null,
  }, staffAuthStore: { async getSession(token) {
    return token === TOKEN ? { businessId: state.tenant, role: state.role } : null;
  } }, dashboardStore: { async getSummary() { return summary; },
    async listDrafts() { return drafts; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('bilingual dashboard renders only explicitly enabled owner-review navigation', () => {
  for (const [lang, caption] of [['fr', 'Réviser les brouillons'], ['en', 'Review drafts']]) {
    const without = renderDashboard({ summary, drafts, language: lang });
    const withOwner = renderDashboard({ summary, drafts, language: lang, ownerReview: true });
    assert.doesNotMatch(without, /\/internal\/review\?/);
    assert.match(withOwner, new RegExp(`href="/internal/review\\?lang=${lang}">${caption}`));
    assert.equal((withOwner.match(/<form\b/g) || []).length, 1, 'review link must never auto-submit');
    assert.doesNotMatch(withOwner, new RegExp(TOKEN));
  }
  assert.throws(() => renderDashboard({ summary, drafts, ownerReview: 'OWNER' }), TypeError);
});

test('live session role and configured private origin decide owner navigation; staff and cross-tenant denied', async () => {
  await withServer('https://fictional.example.test', async (base, state) => {
    const request = () => fetch(base + '/internal/dashboard?lang=fr', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.match(await (await request()).text(), /href="\/internal\/review\?lang=fr"/);
    state.role = 'STAFF';
    const staff = await request();
    assert.equal(staff.status, 200);
    assert.doesNotMatch(await staff.text(), /\/internal\/review\?/);
    state.role = 'OWNER'; state.tenant = 'different-business';
    assert.equal((await request()).status, 401);
    assert.equal((await fetch(base + '/internal/dashboard?lang=fr',
      { headers: { 'X-Admin-Key': 'synthetic-admin-nav-key' } })).status, 401);
  });
  await withServer(null, async base => {
    const response = await fetch(base + '/internal/dashboard?lang=en', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /\/internal\/review\?/);
  });
});
