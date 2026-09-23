'use strict';

const {
  buildWaveInvoiceCreateRequest,
  classifyWaveInvoiceCreateResult,
} = require('./wave-invoice-create-contract');

class SimulatedWaveExecutionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SimulatedWaveExecutionError';
    this.code = code;
  }
}

function exactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'attemptKey,authorizationId,simulatedTransportResult,waveCreateInput') {
    throw new SimulatedWaveExecutionError('INVALID_SIMULATED_EXECUTION');
  }
  return input;
}

function createSimulatedWaveIssuancePipeline({ providerStore }) {
  if (!providerStore ||
      typeof providerStore.beginAttempt !== 'function' ||
      typeof providerStore.recordOutcome !== 'function') {
    throw new TypeError('Provider issuance store required');
  }

  async function execute(input) {
    const fields = exactInput(input);

    // Validate and freeze the provider contract before any persistent attempt is opened.
    // This module intentionally has no fetch/http client and accepts no access token.
    const request = buildWaveInvoiceCreateRequest(fields.waveCreateInput);

    const attempt = await providerStore.beginAttempt({
      authorizationId: fields.authorizationId,
      attemptKey: fields.attemptKey,
      provider: 'WAVE',
    });

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
