'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CUSTOMER_QUERY,
  PRODUCT_QUERY,
  SALES_TAX_QUERY,
  WaveMappingReadError,
  waveRateToMilliPercent,
  readWaveCustomerMapping,
  readWaveProductMapping,
  readWaveSalesTaxMapping,
} = require('../src/wave-mapping-read-client');

function fakeFetch(payload, status = 200, capture = []) {
  return async (url, init) => {
    capture.push({ url, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('fixed mapping queries are read-only GraphQL operations', () => {
  for (const query of [CUSTOMER_QUERY, PRODUCT_QUERY, SALES_TAX_QUERY]) {
    assert.match(query, /^query /);
    assert.doesNotMatch(query, /\bmutation\b/);
  }
});

test('reads exact customer mapping through a fixed query', async () => {
  const capture = [];
  const result = await readWaveCustomerMapping({
    token: 'synthetic-token',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    fetchImpl: fakeFetch({
      data: {
        business: {
          id: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
          customer: {
            id: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
            name: 'Synthetic Customer',
            email: 'customer@example.test',
            modifiedAt: '2026-09-23T12:00:00Z',
            currency: { code: 'CAD' },
          },
        },
      },
    }, 200, capture),
  });
  assert.equal(result.email, 'customer@example.test');
  assert.equal(result.currency, 'CAD');
  assert.equal(capture.length, 1);
  assert.equal(capture[0].init.method, 'POST');
  assert.match(capture[0].init.headers.Authorization, /^Bearer /);
  const body = JSON.parse(capture[0].init.body);
  assert.equal(body.query, CUSTOMER_QUERY);
  assert.equal(body.variables.customerId, 'Q3VzdG9tZXI6ZXhhbXBsZQ==');
});

test('reads product sale/archival state without mutating Wave', async () => {
  const result = await readWaveProductMapping({
    token: 'synthetic-token',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    productId: 'UHJvZHVjdDpleGFtcGxl',
    fetchImpl: fakeFetch({
      data: {
        business: {
          id: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
          product: {
            id: 'UHJvZHVjdDpleGFtcGxl',
            name: 'Synthetic service',
            unitPrice: '12.50',
            isSold: true,
            isArchived: false,
            modifiedAt: '2026-09-23T12:00:00Z',
          },
        },
      },
    }),
  });
  assert.equal(result.isSold, true);
  assert.equal(result.isArchived, false);
  assert.equal(result.unitPrice, '12.50');
});

test('converts exact Wave tax rate to internal milli-percent and preserves compound state', async () => {
  assert.equal(waveRateToMilliPercent('0.05'), 5000);
  assert.equal(waveRateToMilliPercent('0.09975'), 9975);
  assert.throws(() => waveRateToMilliPercent('0.099751'),
    error => error instanceof WaveMappingReadError &&
      error.code === 'WAVE_TAX_RATE_PRECISION_MISMATCH');

  const result = await readWaveSalesTaxMapping({
    token: 'synthetic-token',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    salesTaxId: 'U2FsZXNUYXg6UVNU',
    forDate: '2026-09-23',
    fetchImpl: fakeFetch({
      data: {
        business: {
          id: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
          salesTax: {
            id: 'U2FsZXNUYXg6UVNU',
            abbreviation: 'QST',
            rate: '0.09975',
            isCompound: false,
            isArchived: false,
            modifiedAt: '2026-09-23T12:00:00Z',
          },
        },
      },
    }),
  });
  assert.equal(result.code, 'QST');
  assert.equal(result.rateMilliPercent, 9975);
  assert.equal(result.isCompound, false);
  assert.equal(result.forDate, '2026-09-23');
});

test('fails closed on business/node mismatches and GraphQL errors', async () => {
  await assert.rejects(readWaveCustomerMapping({
    token: 'synthetic-token',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    fetchImpl: fakeFetch({
      data: { business: { id: 'WRONG', customer: null } },
    }),
  }), error => error instanceof WaveMappingReadError &&
    error.code === 'WAVE_BUSINESS_MISMATCH');

  await assert.rejects(readWaveProductMapping({
    token: 'synthetic-token',
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    productId: 'UHJvZHVjdDpleGFtcGxl',
    fetchImpl: fakeFetch({ errors: [{ message: 'Synthetic' }] }),
  }), error => error instanceof WaveMappingReadError &&
    error.code === 'WAVE_GRAPHQL_ERROR');
});
