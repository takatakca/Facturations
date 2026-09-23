'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');
const { previewDraft } = require('../src/draft-preview');
const {
  createWaveDraftInvoice,
  WaveInvoiceCreateError,
  CREATE_DRAFT_MUTATION,
  WAVE_GRAPHQL_URL,
  buildWaveDraftVariables,
} = require('../src/wave-invoice-create-client');

function plan() {
  const preview = previewDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic customer', email: 'customer@example.test', address: 'Example only' },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Synthetic create test',
    lines: [
      { description: 'Taxable service', quantity: 2, unitPriceCents: 1500, taxable: true },
      { description: 'Non-taxable service', quantity: 1, unitPriceCents: 500, taxable: false },
    ],
    taxes: [
      { code: 'GST', label: 'Synthetic GST', rateMilliPercent: 5000 },
      { code: 'QST', label: 'Synthetic QST', rateMilliPercent: 9975 },
    ],
  });
  return buildWaveIssuancePreflight({
    snapshot: { ...preview, status: 'DRAFT', persisted: true },
    businessId: 'wave-business-synthetic',
    customerId: 'wave-customer-synthetic',
    productIds: ['wave-product-1', 'wave-product-2'],
    salesTaxes: {
      GST: { id: 'wave-tax-gst', rateMilliPercent: 5000 },
      QST: { id: 'wave-tax-qst', rateMilliPercent: 9975 },
    },
  });
}
function successPayload(p = plan()) {
  return {
    data: {
      invoiceCreate: {
        didSucceed: true,
        inputErrors: [],
        invoice: {
          id: 'wave-invoice-synthetic',
          invoiceNumber: 'SYNTHETIC-1001',
          status: 'DRAFT',
          invoiceDate: p.invoiceDate,
          dueDate: p.dueDate,
          customer: { id: p.customerId },
          currency: { code: 'CAD' },
          total: { value: (p.expected.totalCents / 100).toFixed(2) },
        },
      },
    },
  };
}
function mock(status, payload, verify = () => {}) {
  return async (url, options) => {
    assert.equal(url, WAVE_GRAPHQL_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.query, CREATE_DRAFT_MUTATION);
    verify(body.variables);
    return new Response(JSON.stringify(payload), { status });
  };
}
async function expectError(work, code, classification, statusCode) {
  await assert.rejects(work, error =>
    error instanceof WaveInvoiceCreateError &&
    error.code === code &&
    error.classification === classification &&
    error.statusCode === statusCode);
}

test('builds a DRAFT-only Wave mutation and accepts an exact synthetic response', async () => {
  const p = plan();
  const variables = buildWaveDraftVariables(p);
  assert.equal(variables.input.status, 'DRAFT');
  assert.equal(variables.input.currency, 'CAD');
  assert.equal(variables.input.businessId, p.businessId);
  assert.equal(variables.input.customerId, p.customerId);
  assert.equal(variables.input.invoiceNumber, undefined,
    'Wave must generate the official invoice number');
  assert.deepEqual(variables.input.items[0].taxes, [
    { salesTaxId: 'wave-tax-gst' },
    { salesTaxId: 'wave-tax-qst' },
  ]);
  assert.deepEqual(variables.input.items[1].taxes, []);
  assert.equal(variables.input.items[0].unitPrice, '15.00');

  const result = await createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(200, successPayload(p), sent => {
      assert.equal(sent.input.invoiceNumber, undefined);
      assert.equal(sent.input.status, 'DRAFT');
      assert.equal(sent.input.items.length, 2);
    }),
  });
  assert.deepEqual(result, {
    provider: 'WAVE',
    providerInvoiceId: 'wave-invoice-synthetic',
    officialInvoiceNumber: 'SYNTHETIC-1001',
    status: 'DRAFT_CREATED_AT_PROVIDER',
    totalCents: p.expected.totalCents,
    approved: false,
    sent: false,
  });
});

test('transport is explicit and never silently defaults to a live network call', async () => {
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: plan(),
  }), 'EXPLICIT_WAVE_TRANSPORT_REQUIRED', 'FINAL', 503);
});

test('transport errors and uncertain upstream responses are classified ambiguous', async () => {
  const p = plan();
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: async () => { throw new Error('synthetic timeout'); },
  }), 'WAVE_CREATE_TRANSPORT_AMBIGUOUS', 'AMBIGUOUS', 504);

  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(500, {}),
  }), 'WAVE_CREATE_UPSTREAM_AMBIGUOUS', 'AMBIGUOUS', 502);

  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(200, { errors: [{ message: 'synthetic error' }] }),
  }), 'WAVE_CREATE_GRAPHQL_AMBIGUOUS', 'AMBIGUOUS', 502);

  const mismatch = successPayload(p);
  mismatch.data.invoiceCreate.invoice.total.value =
    ((p.expected.totalCents + 1) / 100).toFixed(2);
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(200, mismatch),
  }), 'WAVE_CREATE_TOTAL_MISMATCH', 'AMBIGUOUS', 409);
});

test('definite authorization/rate-limit/input failures use non-ambiguous classifications', async () => {
  const p = plan();
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(401, {}),
  }), 'WAVE_AUTH_FAILED', 'FINAL', 502);
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(403, {}),
  }), 'WAVE_ACCESS_DENIED', 'FINAL', 502);
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(429, {}),
  }), 'WAVE_RATE_LIMITED', 'RETRYABLE', 503);
  await expectError(() => createWaveDraftInvoice({
    token: 'synthetic-token',
    plan: p,
    fetchImpl: mock(200, {
      data: { invoiceCreate: {
        didSucceed: false,
        inputErrors: [{ code: 'SYNTHETIC', message: 'bad input', path: ['input'] }],
        invoice: null,
      } },
    }),
  }), 'WAVE_CREATE_REJECTED', 'FINAL', 422);
});

test('successful response must match customer, dates, CAD, DRAFT and official provider fields', async () => {
  const p = plan();
  for (const mutate of [
    x => { x.invoice.id = ''; },
    x => { x.invoice.invoiceNumber = ''; },
    x => { x.invoice.status = 'SAVED'; },
    x => { x.invoice.customer.id = 'other-customer'; },
    x => { x.invoice.currency.code = 'USD'; },
    x => { x.invoice.invoiceDate = '2026-09-24'; },
  ]) {
    const payload = successPayload(p);
    mutate(payload.data.invoiceCreate);
    await expectError(() => createWaveDraftInvoice({
      token: 'synthetic-token',
      plan: p,
      fetchImpl: mock(200, payload),
    }), 'WAVE_CREATE_MISMATCH', 'AMBIGUOUS', 502);
  }
});
