'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewDraft, DraftValidationError } = require('../src/draft-preview');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const key = 'k'.repeat(64);
function valid() {
  return { currency: 'CAD', customer: { name: 'Example Customer', email: 'customer@example.test' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20',
    lines: [{ description: 'Website services', quantity: 2, unitPriceCents: 10005, discountCents: 10, taxable: true },
      { description: 'Non-taxed item', quantity: 1, unitPriceCents: 200, taxable: false }],
    taxes: [{ code: 'GST', label: 'Example GST', rateMilliPercent: 5000 },
      { code: 'QST', label: 'Example QST', rateMilliPercent: 9975 }] };
}
function invalid(draft, code) {
  assert.throws(() => previewDraft(draft), (error) => error instanceof DraftValidationError && error.code === code);
}
test('integer cents and independently rounded taxes, discount, untaxed line', () => {
  const result = previewDraft(valid());
  assert.equal(result.subtotalCents, 20200);
  assert.equal(result.taxableSubtotalCents, 20000);
  assert.deepEqual(result.taxes.map(t => t.amountCents), [1000, 1995]);
  assert.equal(result.totalCents, 23195);
  assert.equal(result.status, 'PREVIEW_ONLY');
  assert.equal(result.persisted, false);
  assert.equal(result.waveSynced, false);
  assert.equal(result.emailed, false);
});
test('fractional cent rounds half up without floating point', () => {
  const input = valid(); input.lines = [{ description: 'One cent', quantity: 1, unitPriceCents: 1, taxable: true }];
  input.taxes = [{ code: 'FIFTY', label: 'Half', rateMilliPercent: 50000 }];
  assert.equal(previewDraft(input).taxTotalCents, 1);
});
test('zero taxes and zero dollar line supported', () => {
  const input = valid(); input.taxes = []; input.lines = [{ description: 'Courtesy', quantity: 1, unitPriceCents: 0, taxable: false }];
  assert.equal(previewDraft(input).totalCents, 0);
});
test('does not invent tax rates', () => {
  const input = valid(); input.taxes = [];
  assert.equal(previewDraft(input).taxTotalCents, 0);
});
test('invalid inputs are rejected with stable codes', () => {
  const cases = [
    [x => x.currency = 'USD', 'UNSUPPORTED_CURRENCY'],
    [x => x.customer.email = 'invalid', 'INVALID_CUSTOMER_EMAIL'],
    [x => x.lines = [], 'INVALID_LINES'],
    [x => x.lines[0].quantity = 1.5, 'INVALID_QUANTITY'],
    [x => x.lines[0].unitPriceCents = 0.1, 'INVALID_UNIT_PRICE'],
    [x => x.lines[0].discountCents = 999999, 'INVALID_DISCOUNT'],
    [x => x.lines[0].taxable = 'yes', 'INVALID_TAXABLE_FLAG'],
    [x => x.taxes[1].code = 'GST', 'INVALID_TAX_CODE'],
    [x => x.taxes[0].rateMilliPercent = 1.5, 'INVALID_TAX_RATE'],
    [x => x.dueDate = '2026-09-19', 'DUE_DATE_BEFORE_INVOICE_DATE'],
    [x => x.invoiceDate = '2026-02-30', 'INVALID_INVOICE_DATE'],
    [x => x.notes = 'a'.repeat(1001), 'INVALID_NOTES'],
    [x => x.lines[0].description = 'a\ninvalid', 'INVALID_DESCRIPTION'],
  ];
  for (const [mutate, code] of cases) { const input = valid(); mutate(input); invalid(input, code); }
});
test('server preview requires auth; never contacts Wave, and never creates invoice', async () => {
  let calls = 0;
  const server = createServer({ config: { adminKey: key, waveToken: 'not-needed' }, fetchImpl: () => { calls++; throw Error('Wave must not be called'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid()) });
    assert.equal(denied.status, 401);
    const response = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(valid()) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).totalCents, 23195);
    assert.equal(calls, 0);
    const invalidType = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(invalidType.status, 415);
    const invalidJson = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    const badData = valid(); badData.currency = 'USD';
    const invalidBody = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(badData) });
    assert.equal(invalidBody.status, 422);
    const oversized = await fetch(`${base}/api/drafts/preview`, { method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'x'.repeat(40000) }) });
    assert.equal(oversized.status, 413);
    const invoice = await fetch(`${base}/api/invoices`, { method: 'POST', headers: { 'X-Admin-Key': key } });
    assert.equal(invoice.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
