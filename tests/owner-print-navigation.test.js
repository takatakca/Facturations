'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDetail } = require('../src/browser-owner-review');
const { previewDraft } = require('../src/draft-preview');

const ID = '22222222-2222-4222-8222-222222222222';
function draft() {
  const calculated = previewDraft({ currency: 'CAD',
    customer: { name: 'Fictional client', email: 'client@example.test' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20',
    lines: [{ description: 'Synthetic service', quantity: 1, unitPriceCents: 2500,
      discountCents: 0, taxable: false }], taxes: [] });
  return { id: ID, status: 'DRAFT', preview: { ...calculated, status: 'DRAFT', persisted: true } };
}

test('FR/EN immutable review reveals print route only after internal approval', () => {
  for (const language of ['fr', 'en']) {
    const href = `/internal/review/${ID}/print?lang=${language}`;
    const pending = renderDetail(draft(), language, 'A'.repeat(43), false);
    assert.doesNotMatch(pending, new RegExp(href.replace('?', '\\?')));
    assert.match(pending, /APPROVE_DRAFT_ONLY/);
    const approved = renderDetail(draft(), language, '', true);
    assert.match(approved, new RegExp(href.replace('?', '\\?')));
    assert.doesNotMatch(approved, /APPROVE_DRAFT_ONLY/);
    assert.match(approved, language === 'fr' ? /brouillon non émis/ : /unissued draft/i);
  }
});
