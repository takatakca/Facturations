'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WAVE_INVOICE_CREATE_MUTATION,
  WaveCreateContractError,
  buildWaveInvoiceCreateRequest,
  classifyWaveInvoiceCreateResult,
} = require('../src/wave-invoice-create-contract');

function validInput(overrides = {}) {
  return {
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    status: 'DRAFT',
    currency: 'CAD',
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    items: [{
      productId: 'UHJvZHVjdDpleGFtcGxl',
      description: 'Synthetic service',
      quantity: '2',
      unitPrice: '12.50',
      salesTaxIds: ['U2FsZXNUYXg6ZXhhbXBsZQ=='],
    }],
    discounts: [{
      discountType: 'PERCENTAGE',
      name: 'Example discount',
      percentage: '10',
    }],
    memo: 'Synthetic only',
    ...overrides,
  };
}

test('builds a fixed invoiceCreate contract without network I/O', () => {
  const request = buildWaveInvoiceCreateRequest(validInput());

  assert.equal(request.operationName, 'FacturationsCreateInvoice');
  assert.equal(request.query, WAVE_INVOICE_CREATE_MUTATION);
  assert.match(request.query, /invoiceCreate\(input: \$input\)/);
  assert.equal(request.networkPerformed, false);
  assert.equal(request.variables.input.status, 'DRAFT');
  assert.equal(request.variables.input.currency, 'CAD');
  assert.equal(request.variables.input.items[0].quantity, '2');
  assert.equal(request.variables.input.items[0].unitPrice, '12.50');
  assert.deepEqual(request.variables.input.items[0].taxes,
    [{ salesTaxId: 'U2FsZXNUYXg6ZXhhbXBsZQ==' }]);

  assert.equal(
    Object.hasOwn(request.variables.input, 'invoiceNumber'),
    false,
    'The create request must not invent an official invoice number'
  );
});

test('rejects unsupported or ambiguous mappings', () => {
  assert.throws(
    () => buildWaveInvoiceCreateRequest(validInput({ status: 'SAVED' })),
    error => error instanceof WaveCreateContractError &&
      error.code === 'WAVE_CREATE_MUST_START_DRAFT'
  );

  assert.throws(
    () => buildWaveInvoiceCreateRequest(validInput({ currency: 'USD' })),
    error => error instanceof WaveCreateContractError &&
      error.code === 'UNSUPPORTED_WAVE_CURRENCY'
  );

  assert.throws(
    () => buildWaveInvoiceCreateRequest(validInput({ invoiceDate: '2026-02-31' })),
    error => error instanceof WaveCreateContractError &&
      error.code === 'INVALID_WAVE_INVOICE_DATE'
  );

  assert.throws(
    () => buildWaveInvoiceCreateRequest(validInput({
      invoiceDate: '2026-10-24',
      dueDate: '2026-10-23',
    })),
    error => error instanceof WaveCreateContractError &&
      error.code === 'WAVE_DUE_DATE_BEFORE_INVOICE_DATE'
  );

  assert.throws(
    () => buildWaveInvoiceCreateRequest(validInput({
      discounts: [
        { discountType: 'FIXED', name: 'One', amount: '1.00' },
        { discountType: 'FIXED', name: 'Two', amount: '1.00' },
      ],
    })),
    error => error instanceof WaveCreateContractError &&
      error.code === 'WAVE_DISCOUNT_LIMIT_EXCEEDED'
  );

  const zeroQuantity = validInput();
  zeroQuantity.items = [{ ...zeroQuantity.items[0], quantity: '0' }];
  assert.throws(
    () => buildWaveInvoiceCreateRequest(zeroQuantity),
    error => error instanceof WaveCreateContractError &&
      error.code === 'INVALID_WAVE_QUANTITY'
  );
});

test('classifies a complete successful create response as confirmed', () => {
  const result = classifyWaveInvoiceCreateResult({
    kind: 'HTTP_RESPONSE',
    status: 200,
    payload: {
      data: {
        invoiceCreate: {
          didSucceed: true,
          inputErrors: [],
          invoice: {
            id: 'SW52b2ljZTpleGFtcGxl',
            invoiceNumber: 'EXAMPLE-1001',
            status: 'DRAFT',
          },
        },
      },
    },
  });

  assert.deepEqual(result, {
    outcome: 'CONFIRMED',
    providerInvoiceId: 'SW52b2ljZTpleGFtcGxl',
    providerInvoiceNumber: 'EXAMPLE-1001',
    providerStatus: 'DRAFT',
    reason: 'WAVE_CONFIRMED',
  });
});

test('classifies timeout and uncertain server responses as ambiguous', () => {
  assert.deepEqual(
    classifyWaveInvoiceCreateResult({ kind: 'TIMEOUT' }),
    { outcome: 'AMBIGUOUS', reason: 'TIMEOUT' }
  );

  assert.deepEqual(
    classifyWaveInvoiceCreateResult({ kind: 'NETWORK_LOST_AFTER_SEND' }),
    { outcome: 'AMBIGUOUS', reason: 'NETWORK_LOST_AFTER_SEND' }
  );

  assert.deepEqual(
    classifyWaveInvoiceCreateResult({
      kind: 'HTTP_RESPONSE',
      status: 503,
      payload: null,
    }),
    { outcome: 'AMBIGUOUS', reason: 'HTTP_503' }
  );

  assert.deepEqual(
    classifyWaveInvoiceCreateResult({
      kind: 'HTTP_RESPONSE',
      status: 200,
      payload: { errors: [{ message: 'Synthetic GraphQL error' }] },
    }),
    { outcome: 'AMBIGUOUS', reason: 'GRAPHQL_ERRORS' }
  );

  assert.deepEqual(
    classifyWaveInvoiceCreateResult({
      kind: 'HTTP_RESPONSE',
      status: 200,
      payload: {
        data: {
          invoiceCreate: {
            didSucceed: true,
            inputErrors: [],
            invoice: {
              id: 'SW52b2ljZTpleGFtcGxl',
              invoiceNumber: '',
              status: 'DRAFT',
            },
          },
        },
      },
    }),
    { outcome: 'AMBIGUOUS', reason: 'INCOMPLETE_CONFIRMED_INVOICE' }
  );
});

test('classifies safe retry and final failures separately', () => {
  assert.deepEqual(
    classifyWaveInvoiceCreateResult({
      kind: 'HTTP_RESPONSE',
      status: 429,
      payload: null,
    }),
    { outcome: 'FAILED_RETRYABLE', reason: 'HTTP_429' }
  );

  assert.deepEqual(
    classifyWaveInvoiceCreateResult({
      kind: 'HTTP_RESPONSE',
      status: 401,
      payload: null,
    }),
    { outcome: 'FAILED_FINAL', reason: 'HTTP_401' }
  );

  const invalid = classifyWaveInvoiceCreateResult({
    kind: 'HTTP_RESPONSE',
    status: 200,
    payload: {
      data: {
        invoiceCreate: {
          didSucceed: false,
          inputErrors: [{
            code: 'INVALID_INPUT',
            message: 'Synthetic validation failure',
            path: ['input', 'customerId'],
          }],
          invoice: null,
        },
      },
    },
  });
  assert.equal(invalid.outcome, 'FAILED_FINAL');
  assert.equal(invalid.reason, 'INPUT_ERRORS');
  assert.equal(invalid.inputErrors.length, 1);
  assert.equal(invalid.inputErrors[0].code, 'INVALID_INPUT');
});
