'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDashboard } = require('../src/dashboard-view');

const summary = { status: 'DRAFTS_ONLY', draftCount: '0', customerCount: '0', draftTotalCents: '0' };
const drafts = { status: 'DRAFTS_ONLY', drafts: [] };

test('bilingual dashboard exposes only the separately guarded editor link, not credentials or invoice actions', () => {
  for (const [language, label] of [['fr', 'Nouveau brouillon de travail'], ['en', 'New working draft']]) {
    const html = renderDashboard({ summary, drafts, language });
    assert.ok(html.includes(`<a class="editor-link" href="/internal/editor?lang=${language}">${label}</a>`));
    assert.equal((html.match(/<form\b/g) || []).length, 1); // Existing logout form only.
    assert.doesNotMatch(html, /<script|X-Admin-Key|csrfToken|\/api\/wave\/|\/api\/invoices/);
  }
});
