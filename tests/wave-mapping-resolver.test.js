'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWaveMappingResolver,
  WaveMappingResolverError,
} = require('../src/wave-mapping-resolver');

function draft() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'DRAFT',
    preview: {
      status: 'DRAFT',
      persisted: true,
      currency: 'CAD',
      customer: { name: 'Synthetic', email: 'customer@example.test', address: 'Example' },
      invoiceDate: '2026-09-23',
      dueDate: '2026-10-23',
      notes: 'Synthetic',
      lines: [{
        description: 'Service',
        quantity: 2,
        unitPriceCents: 1250,
        discountCents: 0,
        taxable: true,
        lineTotalCents: 2500,
      }],
      taxes: [{
        code: 'QST',
        label: 'Example QST',
        rateMilliPercent: 9975,
        amountCents: 249,
      }],
      subtotalCents: 2500,
      taxableSubtotalCents: 2500,
      taxTotalCents: 249,
      totalCents: 2749,
    },
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  const authorized = draft();
  return {
    calls,
    providerStore: {
      async loadAuthorizedDraft(input) {
        calls.push(['authorization', input]);
        return {
          authorizationId: input.authorizationId,
          draftId: authorized.id,
          provider: 'WAVE',
          draft: authorized,
        };
      },
    },
    async readCustomer(input) {
      calls.push(['customer', input]);
      return {
        businessId: input.businessId,
        id: input.customerId,
        name: 'Synthetic',
        email: 'customer@example.test',
        currency: 'CAD',
        modifiedAt: '2026-09-23T12:00:00Z',
        ...(overrides.customer || {}),
      };
    },
    async readProduct(input) {
      calls.push(['product', input]);
      return {
        businessId: input.businessId,
        id: input.productId,
        name: 'Service',
        unitPrice: '12.50',
        isSold: true,
        isArchived: false,
        modifiedAt: '2026-09-23T12:00:00Z',
        ...(overrides.product || {}),
      };
    },
    async readSalesTax(input) {
      calls.push(['tax', input]);
      return {
        businessId: input.businessId,
        id: input.salesTaxId,
        code: 'QST',
        rateMilliPercent: 9975,
        isCompound: false,
        isArchived: false,
        modifiedAt: '2026-09-23T12:00:00Z',
        forDate: input.forDate,
        ...(overrides.tax || {}),
      };
    },
  };
}

function input(overrides = {}) {
  return {
    authorizationId: '22222222-2222-4222-8222-222222222222',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    productIds: ['UHJvZHVjdDpleGFtcGxl'],
    taxIdsByCode: { QST: 'U2FsZXNUYXg6UVNU' },
    ...overrides,
  };
}

function resolver(overrides = {}) {
  const deps = dependencies(overrides);
  return {
    deps,
    value: createWaveMappingResolver({
      providerStore: deps.providerStore,
      token: 'synthetic-read-token',
      readCustomer: deps.readCustomer,
      readProduct: deps.readProduct,
      readSalesTax: deps.readSalesTax,
    }),
  };
}

test('resolves verified Wave mappings from the authorized snapshot only', async () => {
  const { value, deps } = resolver();
  const result = await value.resolve(input());

  assert.equal(result.authorizationId, '22222222-2222-4222-8222-222222222222');
  assert.equal(result.draftId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.mapping.customerId, 'Q3VzdG9tZXI6ZXhhbXBsZQ==');
  assert.deepEqual(result.mapping.productIds, ['UHJvZHVjdDpleGFtcGxl']);
  assert.deepEqual(result.mapping.taxProfiles, [{
    code: 'QST',
    salesTaxId: 'U2FsZXNUYXg6UVNU',
    rateMilliPercent: 9975,
    isCompound: false,
  }]);
  assert.equal(result.networkMode, 'READ_ONLY');
  assert.equal(result.mutationPerformed, false);
  assert.deepEqual(deps.calls.map(call => call[0]), ['authorization', 'customer', 'product', 'tax']);
  assert.ok(deps.calls.slice(1).every(call => call[1].token === 'synthetic-read-token'));
  assert.equal(JSON.stringify(result).includes('synthetic-read-token'), false);
});

test('refuses customer identity or currency mismatches', async () => {
  let current = resolver({ customer: { email: 'other@example.test' } }).value;
  await assert.rejects(current.resolve(input()),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'WAVE_CUSTOMER_EMAIL_MISMATCH');

  current = resolver({ customer: { currency: 'USD' } }).value;
  await assert.rejects(current.resolve(input()),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'WAVE_CUSTOMER_CURRENCY_MISMATCH');
});

test('refuses archived or non-sellable products', async () => {
  let current = resolver({ product: { isSold: false } }).value;
  await assert.rejects(current.resolve(input()),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'WAVE_PRODUCT_NOT_SELLABLE');

  current = resolver({ product: { isArchived: true } }).value;
  await assert.rejects(current.resolve(input()),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'WAVE_PRODUCT_ARCHIVED');
});

test('refuses tax code, rate, compound and archive mismatches', async () => {
  const cases = [
    [{ code: 'GST' }, 'WAVE_TAX_CODE_MISMATCH'],
    [{ rateMilliPercent: 5000 }, 'WAVE_TAX_RATE_MISMATCH'],
    [{ isCompound: true }, 'WAVE_COMPOUND_TAX_UNSUPPORTED'],
    [{ isArchived: true }, 'WAVE_TAX_ARCHIVED'],
  ];
  for (const [tax, code] of cases) {
    const current = resolver({ tax }).value;
    await assert.rejects(current.resolve(input()),
      error => error instanceof WaveMappingResolverError && error.code === code);
  }
});

test('requires exact product count and exact tax-code mapping set', async () => {
  const current = resolver().value;
  await assert.rejects(current.resolve(input({ productIds: [] })),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'PRODUCT_MAPPING_MISMATCH');

  await assert.rejects(current.resolve(input({ taxIdsByCode: { GST: 'U2FsZXNUYXg6R1NU' } })),
    error => error instanceof WaveMappingResolverError &&
      error.code === 'TAX_MAPPING_MISMATCH');
});
