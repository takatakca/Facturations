'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSimulatedWaveIssuancePipeline,
  SimulatedWaveExecutionError,
} = require('../src/wave-simulated-execution-pipeline');

function immutableDraft() {
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
    },
  };
}

function mappingRequest(overrides = {}) {
  return {
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    productIds: ['UHJvZHVjdDpleGFtcGxl'],
    taxIdsByCode: {},
    ...overrides,
  };
}

function verifiedMapping() {
  return {
    businessId: 'QnVzaW5lc3M6ZXhhbXBsZQ==',
    customerId: 'Q3VzdG9tZXI6ZXhhbXBsZQ==',
    productIds: ['UHJvZHVjdDpleGFtcGxl'],
    taxProfiles: [],
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

function fakes({ resolvedDraftId = '44444444-4444-4444-8444-444444444444' } = {}) {
  const calls = [];
  const draft = immutableDraft();
  return {
    calls,
    mappingResolver: {
      async resolve(input) {
        calls.push(['resolve', input]);
        return {
          authorizationId: input.authorizationId,
          draftId: resolvedDraftId,
          mapping: verifiedMapping(),
          mutationPerformed: false,
        };
      },
    },
    providerStore: {
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
    },
  };
}

test('requires verified mapping, reloads snapshot, then records simulated confirmation', async () => {
  const deps = fakes();
  const pipeline = createSimulatedWaveIssuancePipeline(deps);
  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'verified_confirmed_123456',
    mappingRequest: mappingRequest(),
    simulatedTransportResult: confirmedTransport(),
  });

  assert.equal(result.mappingVerified, true);
  assert.equal(result.draftId, '44444444-4444-4444-8444-444444444444');
  assert.equal(result.outcome, 'CONFIRMED');
  assert.equal(result.providerInvoiceId, 'SW52b2ljZTpleGFtcGxl');
  assert.equal(result.providerInvoiceNumber, 'EXAMPLE-1001');
  assert.equal(result.networkWritePerformed, false);
  assert.equal(result.issuedLocally, false);
  assert.equal(result.emailed, false);
  assert.equal(result.variables.input.items[0].unitPrice, '12.50');
  assert.deepEqual(deps.calls.map(call => call[0]), ['resolve', 'load', 'begin', 'outcome']);
});

test('refuses verified mapping bound to a different immutable draft before attempt', async () => {
  const deps = fakes({ resolvedDraftId: '55555555-5555-4555-8555-555555555555' });
  const pipeline = createSimulatedWaveIssuancePipeline(deps);

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'wrong_draft_123456789',
    mappingRequest: mappingRequest(),
    simulatedTransportResult: confirmedTransport(),
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'VERIFIED_MAPPING_DRAFT_MISMATCH');

  assert.deepEqual(deps.calls.map(call => call[0]), ['resolve', 'load']);
});

test('ambiguous simulated result persists no external invoice identifiers', async () => {
  const deps = fakes();
  const pipeline = createSimulatedWaveIssuancePipeline(deps);
  const result = await pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'verified_timeout_123456',
    mappingRequest: mappingRequest(),
    simulatedTransportResult: { kind: 'TIMEOUT' },
  });

  assert.equal(result.outcome, 'AMBIGUOUS');
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(result.providerInvoiceId, null);
  assert.equal(result.providerInvoiceNumber, null);
  assert.deepEqual(deps.calls[3][1], {
    attemptId: '11111111-1111-4111-8111-111111111111',
    outcome: 'AMBIGUOUS',
    providerInvoiceId: null,
    providerInvoiceNumber: null,
  });
});

test('does not accept token, raw draft or raw provider payload in execution input', async () => {
  const deps = fakes();
  const pipeline = createSimulatedWaveIssuancePipeline(deps);

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'extra_token_123456789',
    mappingRequest: mappingRequest(),
    simulatedTransportResult: confirmedTransport(),
    token: 'forbidden',
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'INVALID_SIMULATED_EXECUTION');

  await assert.rejects(pipeline.execute({
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptKey: 'raw_mapping_123456789',
    mappingRequest: { ...mappingRequest(), taxProfiles: [] },
    simulatedTransportResult: confirmedTransport(),
  }), error => error instanceof SimulatedWaveExecutionError &&
    error.code === 'INVALID_MAPPING_REQUEST');

  assert.equal(deps.calls.length, 0);
});
