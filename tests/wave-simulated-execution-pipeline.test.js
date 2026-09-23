'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSimulatedWaveIssuancePipeline,
  SimulatedWaveExecutionError,
} = require('../src/wave-simulated-execution-pipeline');
const { WaveCreateContractError } = require('../src/wave-invoice-create-contract');

function waveInput(overrides = {}) {
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
      salesTaxIds: [],
    }],
    discounts: [],
    memo: 'Synthetic only',
    ...overrides,
  };
}

function confirmedTransport() {
  return {
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
  };
}

function fakeProvider() {
  const calls = [];
  return {
    calls,
    async beginAttempt(input) {
      calls.push(['begin', input]);
      return {
        id: '11111111-1111-4111-8111-111111111111',
        authorizationId: input.authorizationId,
        provider: 'WAVE',
        created: true,
      };
    },
    async recordOutcome(input) {
      calls.push(['outcome', input]);
      return {
        id: '22222222-2222-4222-8222-222222222222',
        attemptId: input.attemptId,
        outcome: input.outcome,
        providerInvoiceId: input.providerInvoiceId,
        providerInvoiceNumber: input.providerInvoiceNumber,
      };
    },
  };
}

test('validates request, opens attempt and persists a simulated confirmed result without network', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });
  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'simulated_confirmed_123456',
    waveCreateInput: waveInput(),
    simulatedTransportResult: confirmedTransport(),
  });

  assert.equal(result.outcome, 'CONFIRMED');
  assert.equal(result.providerInvoiceId, 'SW52b2ljZTpleGFtcGxl');
  assert.equal(result.providerInvoiceNumber, 'EXAMPLE-1001');
  assert.equal(result.providerStatus, 'DRAFT');
  assert.equal(result.networkPerformed, false);
  assert.equal(result.issuedLocally, false);
  assert.equal(result.emailed, false);
  assert.equal(result.variables.input.status, 'DRAFT');
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0][0], 'begin');
  assert.deepEqual(provider.calls[1][1], {
    attemptId: '11111111-1111-4111-8111-111111111111',
    outcome: 'CONFIRMED',
    providerInvoiceId: 'SW52b2ljZTpleGFtcGxl',
    providerInvoiceNumber: 'EXAMPLE-1001',
  });
});

test('invalid Wave mapping is rejected before a provider attempt is persisted', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'invalid_mapping_123456789',
    waveCreateInput: waveInput({ currency: 'USD' }),
    simulatedTransportResult: confirmedTransport(),
  }), error => error instanceof WaveCreateContractError &&
    error.code === 'UNSUPPORTED_WAVE_CURRENCY');

  assert.equal(provider.calls.length, 0);
});

test('ambiguous simulated transport persists no external invoice identifiers', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'simulated_timeout_123456',
    waveCreateInput: waveInput(),
    simulatedTransportResult: { kind: 'TIMEOUT' },
  });

  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(result.providerInvoiceId, null);
  assert.equal(result.providerInvoiceNumber, null);
  assert.deepEqual(provider.calls[1][1], {
    attemptId: '11111111-1111-4111-8111-111111111111',
    outcome: 'AMBIGUOUS',
    providerInvoiceId: null,
    providerInvoiceNumber: null,
  });
});

test('execution input is exact and does not accept a token or hidden action flag', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'extra_field_1234567890',
    waveCreateInput: waveInput(),
    simulatedTransportResult: confirmedTransport(),
    token: 'forbidden',
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'INVALID_SIMULATED_EXECUTION');

  assert.equal(provider.calls.length, 0);
});
