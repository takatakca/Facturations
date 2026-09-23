'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSimulatedWaveIssuancePipeline,
  SimulatedWaveExecutionError,
} = require('../src/wave-simulated-execution-pipeline');
const { WaveDraftMappingError } = require('../src/wave-immutable-draft-mapper');

function immutableDraft(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'DRAFT',
    preview: {
      status: 'DRAFT',
      persisted: true,
      currency: 'CAD',
      customer: { name: 'Synthetic customer', email: 'customer@example.test', address: 'Example' },
      invoiceDate: '2026-09-23',
      dueDate: '2026-10-23',
      notes: 'Synthetic only',
      lines: [{
        description: 'Synthetic service',
        quantity: 2,
        unitPriceCents: 1250,
        discountCents: 0,
        taxable: false,
        lineTotalCents: 2500,
      }],
      taxes: [],
      subtotalCents: 2500,
      taxableSubtotalCents: 0,
      taxTotalCents: 0,
      totalCents: 2500,
      ...overrides,
    },
  };
}

function mapping(overrides = {}) {
  return {
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    productIds: ['UHJvZHVjdDpleGFtcGxl'],
    taxProfiles: [],
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

function fakeProvider(draft = immutableDraft()) {
  const calls = [];
  return {
    calls,
    async loadAuthorizedDraft(input) {
      calls.push(['load', input]);
      return {
        authorizationId: input.authorizationId,
        draftId: draft.id,
        provider: 'WAVE',
        draft,
      };
    },
    async beginAttempt(input) {
      calls.push(['begin', input]);
      return {
        id: '11111111-1111-4111-8111-111111111111',
        authorizationId: input.authorizationId,
        draftId: draft.id,
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

test('loads authorized immutable draft, maps it, then persists simulated confirmed result', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });
  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'simulated_confirmed_123456',
    mapping: mapping(),
    simulatedTransportResult: confirmedTransport(),
  });

  assert.equal(result.draftId, '44444444-4444-4444-8444-444444444444');
  assert.equal(result.outcome, 'CONFIRMED');
  assert.equal(result.providerInvoiceId, 'SW52b2ljZTpleGFtcGxl');
  assert.equal(result.providerInvoiceNumber, 'EXAMPLE-1001');
  assert.equal(result.providerStatus, 'DRAFT');
  assert.equal(result.networkPerformed, false);
  assert.equal(result.issuedLocally, false);
  assert.equal(result.emailed, false);
  assert.equal(result.variables.input.status, 'DRAFT');
  assert.equal(result.variables.input.items[0].unitPrice, '12.50');
  assert.deepEqual(provider.calls.map(call => call[0]), ['load', 'begin', 'outcome']);
});

test('invalid mapping is rejected before a provider attempt is persisted', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'invalid_mapping_123456789',
    mapping: mapping({ productIds: [] }),
    simulatedTransportResult: confirmedTransport(),
  }), error => error instanceof WaveDraftMappingError &&
    error.code === 'PRODUCT_MAPPING_MISMATCH');

  assert.deepEqual(provider.calls.map(call => call[0]), ['load']);
});

test('ambiguous simulated transport persists no external invoice identifiers', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'simulated_timeout_123456',
    mapping: mapping(),
    simulatedTransportResult: { kind: 'TIMEOUT' },
  });

  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(result.providerInvoiceId, null);
  assert.equal(result.providerInvoiceNumber, null);
  assert.deepEqual(provider.calls[2][1], {
    attemptId: '11111111-1111-4111-8111-111111111111',
    outcome: 'AMBIGUOUS',
    providerInvoiceId: null,
    providerInvoiceNumber: null,
  });
});

test('execution input and mapping are exact and do not accept draft or token substitution', async () => {
  const provider = fakeProvider();
  const pipeline = createSimulatedWaveIssuancePipeline({ providerStore: provider });

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'extra_field_1234567890',
    mapping: mapping(),
    simulatedTransportResult: confirmedTransport(),
    token: 'forbidden',
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'INVALID_SIMULATED_EXECUTION');

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'hidden_draft_123456789',
    mapping: { ...mapping(), draft: immutableDraft() },
    simulatedTransportResult: confirmedTransport(),
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'INVALID_WAVE_MAPPING');

  assert.equal(provider.calls.length, 0);
});
