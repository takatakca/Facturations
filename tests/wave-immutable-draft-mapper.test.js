'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWaveCreateInputFromImmutableDraft,
  WaveDraftMappingError,
} = require('../src/wave-immutable-draft-mapper');
const { buildWaveInvoiceCreateRequest } = require('../src/wave-invoice-create-contract');

function draft(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'DRAFT',
    preview: {
      status: 'DRAFT',
      persisted: true,
      currency: 'CAD',
      customer: { name: 'Synthetic customer', email: 'customer@example.test', address: 'Example' },
      invoiceDate: '2026-09-23',
      dueDate: '2026-10-23',
      notes: 'Synthetic only',
      lines: [
        { description: 'Taxable service', quantity: 2, unitPriceCents: 1250,
          discountCents: 0, taxable: true, lineTotalCents: 2500 },
        { description: 'Non-taxable service', quantity: 1, unitPriceCents: 500,
          discountCents: 0, taxable: false, lineTotalCents: 500 },
      ],
      taxes: [
        { code: 'GST', label: 'Example GST', rateMilliPercent: 5000, amountCents: 125 },
        { code: 'QST', label: 'Example QST', rateMilliPercent: 9975, amountCents: 249 },
      ],
      subtotalCents: 3000,
      taxableSubtotalCents: 2500,
      taxTotalCents: 374,
      totalCents: 3374,
      ...overrides,
    },
  };
}

function mapping(overrides = {}) {
  return {
    draft: draft(),
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    productIds: ['UHJvZHVjdDox', 'UHJvZHVjdDoy'],
    taxProfiles: [
      { code: 'GST', salesTaxId: 'U2FsZXNUYXg6R1NU', rateMilliPercent: 5000, isCompound: false },
      { code: 'QST', salesTaxId: 'U2FsZXNUYXg6UVNU', rateMilliPercent: 9975, isCompound: false },
    ],
    ...overrides,
  };
}

test('maps an immutable zero-discount snapshot to the exact Wave create contract', () => {
  const input = buildWaveCreateInputFromImmutableDraft(mapping());
  assert.equal(input.status, 'DRAFT');
  assert.equal(input.currency, 'CAD');
  assert.equal(input.items[0].quantity, '2');
  assert.equal(input.items[0].unitPrice, '12.50');
  assert.deepEqual(input.items[0].salesTaxIds, ['U2FsZXNUYXg6R1NU', 'U2FsZXNUYXg6UVNU']);
  assert.deepEqual(input.items[1].salesTaxIds, []);
  assert.deepEqual(input.discounts, []);
  assert.equal(input.memo, 'Synthetic only');

  const request = buildWaveInvoiceCreateRequest(input);
  assert.equal(request.networkPerformed, false);
  assert.equal(request.variables.input.items[0].unitPrice, '12.50');
  assert.equal(Object.hasOwn(request.variables.input, 'invoiceNumber'), false);
});

test('refuses line discounts rather than approximating them into Wave invoice discount', () => {
  const value = mapping();
  value.draft = draft({
    lines: [
      { description: 'Discounted', quantity: 2, unitPriceCents: 1250,
        discountCents: 100, taxable: true, lineTotalCents: 2400 },
    ],
    taxes: [],
    subtotalCents: 2400,
    taxableSubtotalCents: 2400,
    taxTotalCents: 0,
    totalCents: 2400,
  });
  value.productIds = ['UHJvZHVjdDox'];
  value.taxProfiles = [];

  assert.throws(() => buildWaveCreateInputFromImmutableDraft(value),
    error => error instanceof WaveDraftMappingError &&
      error.code === 'LINE_DISCOUNT_MAPPING_UNSUPPORTED');
});

test('requires exact non-compound tax profiles and exact rates', () => {
  const compound = mapping();
  compound.taxProfiles = compound.taxProfiles.map(x => ({ ...x }));
  compound.taxProfiles[1].isCompound = true;
  assert.throws(() => buildWaveCreateInputFromImmutableDraft(compound),
    error => error instanceof WaveDraftMappingError &&
      error.code === 'COMPOUND_TAX_MAPPING_UNSUPPORTED');

  const wrongRate = mapping();
  wrongRate.taxProfiles = wrongRate.taxProfiles.map(x => ({ ...x }));
  wrongRate.taxProfiles[0].rateMilliPercent = 4999;
  assert.throws(() => buildWaveCreateInputFromImmutableDraft(wrongRate),
    error => error instanceof WaveDraftMappingError && error.code === 'TAX_RATE_MISMATCH');

  const missing = mapping({ taxProfiles: [mapping().taxProfiles[0]] });
  assert.throws(() => buildWaveCreateInputFromImmutableDraft(missing),
    error => error instanceof WaveDraftMappingError &&
      error.code === 'TAX_PROFILE_SET_MISMATCH');
});

test('requires one explicit Wave product id per immutable line', () => {
  assert.throws(() => buildWaveCreateInputFromImmutableDraft(mapping({
    productIds: ['UHJvZHVjdDox'],
  })), error => error instanceof WaveDraftMappingError &&
    error.code === 'PRODUCT_MAPPING_MISMATCH');
});

test('detects snapshot arithmetic drift before producing a provider payload', () => {
  const value = mapping();
  value.draft = draft({ totalCents: 3375 });
  assert.throws(() => buildWaveCreateInputFromImmutableDraft(value),
    error => error instanceof WaveDraftMappingError && error.code === 'TOTAL_MISMATCH');
});
