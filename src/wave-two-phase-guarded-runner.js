'use strict';

const {
  buildWaveInvoiceCreateMutation,
  buildWaveInvoiceApproveMutation,
  classifyCreatePayload,
  classifyApprovePayload,
} = require('./wave-mutation-contract-v2');
const { WaveMutationNetworkError } = require('./wave-network-adapter');
const { WaveCreateConfirmationError } = require('./wave-create-confirmation-store');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_CODE = /^[A-Z0-9_:-]{1,160}$/;

class WaveTwoPhaseRunnerError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveTwoPhaseRunnerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactObject(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveTwoPhaseRunnerError(code);
  }
  return input;
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new WaveTwoPhaseRunnerError(code);
  }
  return value;
}

function validateInput(input) {
  exactObject(input, ['authorizationId', 'draftId'], 'INVALID_RUNNER_REQUEST');
  return Object.freeze({
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    draftId: uuid(input.draftId, 'INVALID_DRAFT_ID'),
  });
}

function validateDependencies(mappingStore, executionStore, createConfirmationStore, networkAdapter) {
  if (!mappingStore || typeof mappingStore.getByAuthorization !== 'function') {
    throw new TypeError('Persisted Wave mapping store required');
  }
  if (!executionStore || typeof executionStore.prepare !== 'function' ||
      typeof executionStore.begin !== 'function' ||
      typeof executionStore.recordOutcome !== 'function') {
    throw new TypeError('Provider execution store required');
  }
  if (!createConfirmationStore ||
      typeof createConfirmationStore.save !== 'function' ||
      typeof createConfirmationStore.getByExecution !== 'function') {
    throw new TypeError('Wave create confirmation store required');
  }
  if (!networkAdapter || networkAdapter.mode !== 'AUTHORIZED_TEST_ONLY' ||
      typeof networkAdapter.execute !== 'function') {
    throw new TypeError('AUTHORIZED_TEST_ONLY Wave network adapter required');
  }
}

async function optionalCreateConfirmation(store, executionId) {
  try {
    return await store.getByExecution(executionId);
  } catch (error) {
    if (error instanceof WaveCreateConfirmationError &&
        error.code === 'CREATE_CONFIRMATION_NOT_FOUND' &&
        error.statusCode === 404) return null;
    throw error;
  }
}

function safeCode(value, fallback) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

async function recordNetworkFailure(executionStore, execution, error) {
  const known = error instanceof WaveMutationNetworkError;
  const outcome = known && !error.outcomeUnknown
    ? (error.retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL')
    : 'AMBIGUOUS';
  return executionStore.recordOutcome({
    executionId: execution.id,
    expectedVersion: execution.version,
    outcome,
    providerInvoiceId: null,
    officialInvoiceNumber: null,
    errorCode: safeCode(error?.code, 'WAVE_NETWORK_OUTCOME_UNKNOWN'),
  });
}

async function recordClassification(executionStore, execution, result, prefix) {
  if (result.outcome === 'FAILED_FINAL') {
    return executionStore.recordOutcome({
      executionId: execution.id,
      expectedVersion: execution.version,
      outcome: 'FAILED_FINAL',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: prefix + '_FAILED_FINAL',
    });
  }
  if (result.outcome === 'AMBIGUOUS') {
    return executionStore.recordOutcome({
      executionId: execution.id,
      expectedVersion: execution.version,
      outcome: 'AMBIGUOUS',
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: safeCode(prefix + '_' + result.reason, prefix + '_AMBIGUOUS'),
    });
  }
  throw new WaveTwoPhaseRunnerError('UNEXPECTED_CLASSIFICATION', 502);
}

function createWaveTwoPhaseGuardedRunner({
  mappingStore,
  executionStore,
  createConfirmationStore,
  networkAdapter,
}) {
  validateDependencies(mappingStore, executionStore, createConfirmationStore, networkAdapter);

  async function execute(input) {
    const fields = validateInput(input);
    const mapping = await mappingStore.getByAuthorization(fields.authorizationId);
    if (mapping.authorizationId !== fields.authorizationId ||
        mapping.draftId !== fields.draftId) {
      throw new WaveTwoPhaseRunnerError('MAPPING_CHAIN_MISMATCH', 409);
    }

    const createRequest = buildWaveInvoiceCreateMutation(mapping.plan);
    if (createRequest.variables.input.businessId !== networkAdapter.allowedBusinessId) {
      throw new WaveTwoPhaseRunnerError('NETWORK_BUSINESS_SCOPE_MISMATCH', 403);
    }

    let execution = await executionStore.prepare({
      authorizationId: fields.authorizationId,
      draftId: fields.draftId,
      provider: 'WAVE',
    });

    if (execution.state === 'CONFIRMED') {
      return Object.freeze({
        mappingId: mapping.id,
        execution,
        createConfirmation: await optionalCreateConfirmation(
          createConfirmationStore, execution.id),
        networkMode: networkAdapter.mode,
        idempotent: true,
      });
    }
    if (execution.state === 'FAILED_FINAL') {
      throw new WaveTwoPhaseRunnerError('EXECUTION_FAILED_FINAL', 409);
    }
    if (execution.state === 'AMBIGUOUS') {
      throw new WaveTwoPhaseRunnerError('RECONCILIATION_REQUIRED', 409);
    }

    let createConfirmation = await optionalCreateConfirmation(
      createConfirmationStore, execution.id);

    if (execution.state === 'IN_PROGRESS') {
      if (!createConfirmation) {
        throw new WaveTwoPhaseRunnerError('RECONCILIATION_REQUIRED', 409);
      }
      // A prior process confirmed and persisted the Wave DRAFT before it stopped.
      // Resume only the separate approval mutation; never create another invoice.
    } else {
      execution = await executionStore.begin({
        executionId: execution.id,
        expectedVersion: execution.version,
      });
      createConfirmation = await optionalCreateConfirmation(
        createConfirmationStore, execution.id);
    }

    if (!createConfirmation) {
      let createResponse;
      try {
        createResponse = await networkAdapter.execute({
          businessId: mapping.plan.businessId,
          request: createRequest,
        });
      } catch (error) {
        const outcome = await recordNetworkFailure(executionStore, execution, error);
        return Object.freeze({
          mappingId: mapping.id,
          execution: outcome,
          createConfirmation: null,
          networkMode: networkAdapter.mode,
          idempotent: false,
        });
      }

      const createResult = classifyCreatePayload(createResponse.payload, createRequest);
      if (createResult.outcome !== 'CREATE_CONFIRMED_DRAFT_ONLY') {
        const outcome = await recordClassification(
          executionStore, execution, createResult, 'WAVE_CREATE');
        return Object.freeze({
          mappingId: mapping.id,
          execution: outcome,
          createConfirmation: null,
          networkMode: networkAdapter.mode,
          idempotent: false,
        });
      }

      try {
        createConfirmation = await createConfirmationStore.save({
          executionId: execution.id,
          authorizationId: fields.authorizationId,
          draftId: fields.draftId,
          providerInvoiceId: createResult.providerInvoiceId,
          providerInvoiceNumber: createResult.providerInvoiceNumber,
        });
      } catch (error) {
        // The provider may already contain a created DRAFT. Never call create again
        // after a local persistence failure without operator reconciliation.
        try {
          await executionStore.recordOutcome({
            executionId: execution.id,
            expectedVersion: execution.version,
            outcome: 'AMBIGUOUS',
            providerInvoiceId: null,
            officialInvoiceNumber: null,
            errorCode: 'WAVE_CREATE_PERSISTENCE_AMBIGUOUS',
          });
        } catch { /* Preserve the original persistence failure. */ }
        throw error;
      }
    }

    const approveRequest = buildWaveInvoiceApproveMutation(
      createConfirmation.providerInvoiceId);
    let approveResponse;
    try {
      approveResponse = await networkAdapter.execute({
        businessId: mapping.plan.businessId,
        request: approveRequest,
      });
    } catch (error) {
      const outcome = await recordNetworkFailure(executionStore, execution, error);
      return Object.freeze({
        mappingId: mapping.id,
        execution: outcome,
        createConfirmation,
        networkMode: networkAdapter.mode,
        idempotent: false,
      });
    }

    const approveResult = classifyApprovePayload(
      approveResponse.payload, approveRequest, createRequest.expected);
    if (approveResult.outcome !== 'APPROVE_CONFIRMED') {
      const outcome = await recordClassification(
        executionStore, execution, approveResult, 'WAVE_APPROVE');
      return Object.freeze({
        mappingId: mapping.id,
        execution: outcome,
        createConfirmation,
        networkMode: networkAdapter.mode,
        idempotent: false,
      });
    }

    const outcome = await executionStore.recordOutcome({
      executionId: execution.id,
      expectedVersion: execution.version,
      outcome: 'CONFIRMED',
      providerInvoiceId: approveResult.providerInvoiceId,
      officialInvoiceNumber: approveResult.officialInvoiceNumber,
      errorCode: null,
    });
    return Object.freeze({
      mappingId: mapping.id,
      execution: outcome,
      createConfirmation,
      networkMode: networkAdapter.mode,
      idempotent: false,
    });
  }

  return Object.freeze({ execute });
}

module.exports = {
  createWaveTwoPhaseGuardedRunner,
  WaveTwoPhaseRunnerError,
};
