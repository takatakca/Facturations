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

function createSimulatedWaveIssuancePipeline({ providerStore, mappingResolver }) {
  if (!providerStore ||
      typeof providerStore.loadAuthorizedDraft !== 'function' ||
      typeof providerStore.beginAttempt !== 'function' ||
      typeof providerStore.recordOutcome !== 'function') {
    throw new TypeError('Provider issuance store with authorized snapshot loader required');
  }
  if (!mappingResolver || typeof mappingResolver.resolve !== 'function') {
    throw new TypeError('Verified Wave mapping resolver required');
  }

  async function execute(input) {
    exactObject(input,
      ['attemptKey', 'authorizationId', 'mappingRequest', 'simulatedTransportResult'],
      'INVALID_SIMULATED_EXECUTION');
    const mappingRequest = exactObject(input.mappingRequest,
      ['businessId', 'customerId', 'productIds', 'taxIdsByCode'],
      'INVALID_MAPPING_REQUEST');

    // Resolve all external IDs through the read-only verification layer first.
    const resolved = await mappingResolver.resolve({
      authorizationId: input.authorizationId,
      businessId: mappingRequest.businessId,
      customerId: mappingRequest.customerId,
      productIds: mappingRequest.productIds,
      taxIdsByCode: mappingRequest.taxIdsByCode,
    });
    if (!resolved || resolved.authorizationId !== input.authorizationId ||
        !resolved.mapping || typeof resolved.draftId !== 'string') {
      throw new SimulatedWaveExecutionError('INVALID_VERIFIED_MAPPING');
    }

    // Reload the exact immutable snapshot tied to the authorization. This makes
    // the provider payload a pure function of persisted authorization + verified
    // external mappings, never of caller-supplied invoice data.
    const authorized = await providerStore.loadAuthorizedDraft({
      authorizationId: input.authorizationId,
    });
    if (authorized.draftId !== resolved.draftId) {
      throw new SimulatedWaveExecutionError('VERIFIED_MAPPING_DRAFT_MISMATCH');
    }

    const waveCreateInput = buildWaveCreateInputFromImmutableDraft({
      draft: authorized.draft,
      businessId: resolved.mapping.businessId,
      customerId: resolved.mapping.customerId,
      productIds: resolved.mapping.productIds,
      taxProfiles: resolved.mapping.taxProfiles,
    });
    const request = buildWaveInvoiceCreateRequest(waveCreateInput);

    const attempt = await providerStore.beginAttempt({
      authorizationId: input.authorizationId,
      attemptKey: input.attemptKey,
      provider: 'WAVE',
    });
    if (attempt.draftId !== authorized.draftId) {
      throw new SimulatedWaveExecutionError('AUTHORIZED_DRAFT_CHANGED');
    }

    const classified = classifyWaveInvoiceCreateResult(input.simulatedTransportResult);
    const outcome = await providerStore.recordOutcome({
      attemptId: attempt.id,
      outcome: classified.outcome,
      providerInvoiceId: classified.outcome === 'CONFIRMED'
        ? classified.providerInvoiceId : null,
      providerInvoiceNumber: classified.outcome === 'CONFIRMED'
        ? classified.providerInvoiceNumber : null,
    });

    return Object.freeze({
      authorizationId: input.authorizationId,
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
      mappingVerified: true,
      networkWritePerformed: false,
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
