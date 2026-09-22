'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewDraft } = require('../src/draft-preview');
const { renderDetail } = require('../src/browser-owner-review');

const ID = '44444444-4444-4444-8444-444444444444';
const CSRF = 'C'.repeat(43);
function reviewedDraft() {
  const preview = previewDraft({ currency: 'CAD',
    customer: { name: 'Client <synthetic> & Co', email: 'review@example.test', address: 'Imaginary address' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Instruction <script> & private',
    lines: [{ description: 'Service & parts', quantity: 2, unitPriceCents: 1250,
      discountCents: 100, taxable: true }],
    taxes: [{ code: 'EXAMPLE', label: 'Tax <example>', rateMilliPercent: 9975 }],
  });
  assert.equal(preview.subtotalCents, 2400);
  assert.equal(preview.taxTotalCents, 239);
  assert.equal(preview.totalCents, 2639);
  return { id: ID, status: 'DRAFT', preview: { ...preview, status: 'DRAFT', persisted: true } };
}

test('owner can inspect discounted line, decimal tax %, subtotal, tax amount and escaped notes in FR/EN before approving', () => {
  const row = reviewedDraft();
  for (const language of ['fr', 'en']) {
    const html = renderDetail(row, language, CSRF);
    assert.match(html, new RegExp(`<html lang="${language}"`));
    assert.match(html, /Service &amp; parts/);
    assert.match(html, /Client &lt;synthetic&gt; &amp; Co/);
    assert.match(html, /Tax &lt;example&gt;/);
    assert.match(html, /9\.975%/);
    assert.doesNotMatch(html, /9975 milli-%/);
    assert.match(html, /Instruction &lt;script&gt; &amp; private/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /value="2639"/);
    assert.match(html, /name="csrf" value="C{43}"/);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 4);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.doesNotMatch(html, /invoice number|invoice issued|facture émise.*numéro/i);
    if (language === 'fr') {
      assert.match(html, /Rabais: 1,00/);
      assert.match(html, /Sous-total: 24,00/);
      assert.match(html, /Total des taxes: 2,39/);
      assert.match(html, /Total calculé: 26,39/);
    } else {
      assert.match(html, /Discount: CA\$1\.00/);
      assert.match(html, /Subtotal: CA\$24\.00/);
      assert.match(html, /Total tax: CA\$2\.39/);
      assert.match(html, /Calculated total: CA\$26\.39/);
    }
  }
});

test('rendering rejects a working workspace or unpersisted preview; no approval form after success', () => {
  const row = reviewedDraft();
  assert.throws(() => renderDetail({ ...row, status: 'WORK_IN_PROGRESS' }, 'fr', CSRF), /immutable/);
  assert.throws(() => renderDetail({ ...row, preview: { ...row.preview, persisted: false } }, 'en', CSRF), /immutable/);
  const confirmed = renderDetail(row, 'fr', '', true);
  assert.match(confirmed, /Approbation interne enregistrée/);
  assert.doesNotMatch(confirmed, /<form\b/);
});
