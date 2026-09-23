'use strict';

const {
  buildWaveInvoiceCreateRequest,
  classifyWaveInvoiceCreateResult,
} = require('./wave-invoice-create-contract');
const {
  buildWaveCreateInputFromImmutableDraft,
} = require('./wave-immutable-draft-mapper');

class SimulatedWaveExecutionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SimulatedWaveExecutionError';
    this.code = code;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new SimulatedWaveExecutionError(code);
  }
  return value;
}

function exactInput(input) {
  return exactObject(input,
    ['attemptKey', 'authorizationId', 'mapping', 'simulatedTransportResult'],
    'INVALID_SIMULATED_EXECUTION');
}

function exactMapping(mapping) {
  return exactObject(mapping,
    ['businessId', 'customerId', 'productIds', 'taxProfiles'],
    'INVALID_WAVE_MAPPING');
}

function createSimulatedWaveIssuancePipeline({ providerStore }) {
  if (!providerStore ||
      typeof providerStore.loadAuthorizedDraft !== 'function' ||
      typeof providerStore.beginAttempt !== 'function' ||
      typeof providerStore.recordOutcome !== 'function') {
    throw new TypeError('Provider issuance store with authorized snapshot loader required');
  }

  async function execute(input) {
    const fields = exactInput(input);
    const mapping = exactMapping(fields.mapping);

    // Load the exact immutable draft bound to the persisted authorization. The
    // caller cannot substitute a different draft or raw Wave payload.
    const authorized = await providerStore.loadAuthorizedDraft({
      authorizationId: fields.authorizationId,
    });

    const waveCreateInput = buildWaveCreateInputFromImmutableDraft({
      draft: authorized.draft,
      businessId: mapping.businessId,
      customerId: mapping.customerId,
      productIds: mapping.productIds,
      taxProfiles: mapping.taxProfiles,
    });

    // Final provider schema validation still happens before opening an attempt.
    const request = buildWaveInvoiceCreateRequest(waveCreateInput);

    const attempt = await providerStore.beginAttempt({
      authorizationId: fields.authorizationId,
      attemptKey: fields.attemptKey,
      provider: 'WAVE',
    });

    // Authorization rows and invoice drafts are immutable; disagreement here
    // indicates corrupted/inconsistent storage, not a condition to retry.
    if (attempt.draftId !== authorized.draftId) {
      throw new SimulatedWaveExecutionError('AUTHORIZED_DRAFT_CHANGED');
    }

    const classified = classifyWaveInvoiceCreateResult(fields.simulatedTransportResult);
    const outcome = await providerStore.recordOutcome({
      attemptId: attempt.id,
      outcome: classified.outcome,
      providerInvoiceId: classified.outcome === 'CONFIRMED'
        ? classified.providerInvoiceId : null,
      providerInvoiceNumber: classified.outcome === 'CONFIRMED'
        ? classified.providerInvoiceNumber : null,
    });

    return Object.freeze({
      authorizationId: fields.authorizationId,
      draftId: authorized.draftId,
      attemptId: attempt.id,
      attemptCreated: attempt.created,
      provider: 'WAVE',
      operationName: request.operationName,
      variables: request.variables,
      outcome: outcome.outcome,
      providerInvoiceId: outcome.providerInvoiceId,
      providerInvoiceNumber: outcome.providerInvoiceNumber,
      providerStatus: classified.providerStatus || null,
      reason: classified.reason,
      networkPerformed: false,
      issuedLocally: false,
      emailed: false,
    });
  }

  return Object.freeze({ execute });
}

module.exports = {
  createSimulatedWaveIssuancePipeline,
  SimulatedWaveExecutionError,
};
