'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { previewDraft } = require('../src/draft-preview');
const {
  renderIssuedInvoicePdf,
  OfficialInvoicePdfError,
  encodePdfWinAnsi,
} = require('../src/official-invoice-pdf');

function issued(snapshot) {
  return {
    id: crypto.randomUUID(),
    provider: 'WAVE',
    providerInvoiceId: 'wave-example-' + crypto.randomUUID(),
    officialInvoiceNumber: 'INV-2026-1001',
    status: 'ISSUED_CONFIRMED',
    deliveryState: 'NOT_AUTHORIZED',
    providerConfirmedAt: '2026-09-25T14:30:00.000Z',
    snapshot,
  };
}

function snapshot(lineCount = 1, name = 'Élodie Tremblay') {
  return previewDraft({
    currency: 'CAD',
    customer: {
      name,
      email: 'elodie@example.test',
      address: '123, rue de Montréal, Québec',
    },
    invoiceDate: '2026-09-25',
    dueDate: '2026-10-25',
    notes: 'Merci — paiement selon l’entente.',
    lines: Array.from({ length: lineCount }, (_, index) => ({
      description: 'Service professionnel numéro ' + (index + 1),
      quantity: 1,
      unitPriceCents: 1000 + index,
      discountCents: 0,
      taxable: true,
    })),
    taxes: [
      { code: 'TPS', label: 'TPS', rateMilliPercent: 5000 },
      { code: 'TVQ', label: 'TVQ', rateMilliPercent: 9975 },
    ],
  });
}

test('issued invoice PDF is deterministic, valid-looking and supports common French accents', () => {
  const invoice = issued(snapshot());
  const first = renderIssuedInvoicePdf(invoice);
  const second = renderIssuedInvoicePdf(invoice);
  assert.ok(Buffer.isBuffer(first));
  assert.ok(first.length > 500);
  assert.equal(first.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.ok(first.subarray(-32).toString('ascii').includes('%%EOF'));
  assert.equal(
    crypto.createHash('sha256').update(first).digest('hex'),
    crypto.createHash('sha256').update(second).digest('hex')
  );
  assert.deepEqual(first, second);
  assert.deepEqual(encodePdfWinAnsi('Été à Montréal'), Buffer.from([0xc9,0x74,0xe9,0x20,0xe0,0x20,0x4d,0x6f,0x6e,0x74,0x72,0xe9,0x61,0x6c]));
});

test('issued invoice PDF paginates a maximum-size invoice', () => {
  const pdf = renderIssuedInvoicePdf(issued(snapshot(50)));
  const ascii = pdf.toString('latin1');
  const match = /\/Type \/Pages \/Count (\d+)/u.exec(ascii);
  assert.ok(match);
  assert.ok(Number(match[1]) >= 2);
});

test('renderer refuses unsupported characters instead of corrupting customer text', () => {
  const invoice = issued(snapshot(1, 'Client 🙂'));
  assert.throws(
    () => renderIssuedInvoicePdf(invoice),
    error => error instanceof OfficialInvoicePdfError &&
      error.code === 'UNSUPPORTED_PDF_CHARACTER' &&
      error.statusCode === 409
  );
});
