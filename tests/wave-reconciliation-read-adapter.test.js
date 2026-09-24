'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WAVE_RECONCILE_INVOICE_BY_ID_QUERY,
  WAVE_RECONCILE_INVOICE_SEARCH_QUERY,
  WaveReconciliationReadError,
  createWaveReconciliationReadAdapter,
} = require('../src/wave-reconciliation-read-adapter');

const BUSINESS = 'wave-business-synthetic';
const CUSTOMER = 'wave-customer-synthetic';
const INVOICE = 'wave-invoice-synthetic';
const TOKEN = 'synthetic-read-token-never-real-123456789';

function invoice(status = 'DRAFT', invoiceNumber = 'SYNTHETIC-1001') {
  return {
    id: INVOICE,
    createdAt: '2026-09-23T20:00:00Z',
    modifiedAt: '2026-09-23T20:00:01Z',
    status,
    invoiceNumber,
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    customer: { id: CUSTOMER },
    currency: { code: 'CAD' },
    taxTotal: { value: '0.00' },
    total: { value: '30.00' },
    items: [{
      product: { id: 'wave-product-synthetic' },
      description: 'Synthetic service',
      quantity: '2.00000000',
      unitPrice: '15.00000000',
      taxes: [],
    }],
  };
}

test('read reconciliation adapter is disabled by default before fetch', async () => {
  let calls = 0;
  const adapter = createWaveReconciliationReadAdapter({
    fetchImpl: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(adapter.mode, 'DISABLED');
  await assert.rejects(
    adapter.getInvoiceById({ businessId: BUSINESS, invoiceId: INVOICE }),
    error => error instanceof WaveReconciliationReadError &&
      error.code === 'WAVE_READ_NETWORK_DISABLED'
  );
  assert.equal(calls, 0);
});

test('authorized read mode requires invoice:read independently from invoice:write', () => {
  assert.throws(() => createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: BUSINESS,
    grantedScopes: ['invoice:write'],
    fetchImpl: async () => new Response('{}'),
  }), /invoice:read or invoice:\*/);

  assert.doesNotThrow(() => createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: BUSINESS,
    grantedScopes: ['invoice:read'],
    fetchImpl: async () => new Response('{}'),
  }));
});

test('invoice by id uses only the fixed read query and validates the business', async () => {
  let requestBody;
  const adapter = createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: BUSINESS,
    grantedScopes: ['invoice:read'],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://gql.waveapps.com/graphql/public');
      assert.equal(options.method, 'POST');
      assert.match(options.headers.Authorization, /^Bearer /);
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: { business: { id: BUSINESS, invoice: invoice('SAVED') } },
      }), { status: 200 });
    },
  });

  const found = await adapter.getInvoiceById({ businessId: BUSINESS, invoiceId: INVOICE });
  assert.equal(requestBody.query, WAVE_RECONCILE_INVOICE_BY_ID_QUERY);
  assert.deepEqual(requestBody.variables, { businessId: BUSINESS, invoiceId: INVOICE });
  assert.equal(found.kind, 'FOUND');
  assert.equal(found.invoice.id, INVOICE);
  assert.equal(found.invoice.status, 'SAVED');
  assert.equal(found.invoice.items[0].productId, 'wave-product-synthetic');
  assert.equal(found.invoice.items[0].quantity, '2.00000000');

  await assert.rejects(
    adapter.getInvoiceById({ businessId: 'other-business', invoiceId: INVOICE }),
    error => error instanceof WaveReconciliationReadError &&
      error.code === 'WAVE_BUSINESS_SCOPE_MISMATCH' &&
      error.statusCode === 403
  );
});

test('bounded search fixes page 1/pageSize 20 and exact customer currency and date filters', async () => {
  let requestBody;
  const adapter = createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: BUSINESS,
    grantedScopes: ['invoice:*'],
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: {
          business: {
            id: BUSINESS,
            invoices: {
              pageInfo: { currentPage: 1, totalPages: 1, totalCount: 1 },
              edges: [{ node: invoice() }],
            },
          },
        },
      }), { status: 200 });
    },
  });

  const result = await adapter.searchInvoices({
    businessId: BUSINESS,
    customerId: CUSTOMER,
    currency: 'CAD',
    invoiceDate: '2026-09-23',
  });
  assert.equal(requestBody.query, WAVE_RECONCILE_INVOICE_SEARCH_QUERY);
  assert.deepEqual(requestBody.variables, {
    businessId: BUSINESS,
    page: 1,
    pageSize: 20,
    customerId: CUSTOMER,
    currency: 'CAD',
    invoiceDateStart: '2026-09-23',
    invoiceDateEnd: '2026-09-23',
  });
  assert.equal(result.truncated, false);
  assert.equal(result.invoices.length, 1);
  assert.equal(result.invoices[0].total, '30.00');
});

test('truncated provider result is surfaced instead of being mistaken for exhaustive search', async () => {
  const adapter = createWaveReconciliationReadAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: TOKEN,
    allowedBusinessId: BUSINESS,
    grantedScopes: ['invoice:read'],
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        business: {
          id: BUSINESS,
          invoices: {
            pageInfo: { currentPage: 1, totalPages: 2, totalCount: 21 },
            edges: [{ node: invoice() }],
          },
        },
      },
    }), { status: 200 }),
  });

  const result = await adapter.searchInvoices({
    businessId: BUSINESS,
    customerId: CUSTOMER,
    currency: 'CAD',
    invoiceDate: '2026-09-23',
  });
  assert.equal(result.truncated, true);
  assert.equal(result.totalCount, 21);
});
