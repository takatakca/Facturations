'use strict';

const { ProviderIssuanceAttemptError } = require('./provider-issuance-attempt-store');

class ProviderIssuanceExecutorError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ProviderIssuanceExecutorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validatePreparedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.status !== 'READY_FOR_WAVE_ADAPTER' ||
      payload.operation !== 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY' ||
      payload.currency !== 'CAD' ||
      !Array.isArray(payload.items) ||
      !payload.expected || typeof payload.expected !== 'object' ||
      !payload.externalActionsPerformed ||
      payload.externalActionsPerformed.createInvoice !== false ||
      payload.externalActionsPerformed.approveInvoice !== false ||
      payload.externalActionsPerformed.sendInvoice !== false) {
    throw new ProviderIssuanceExecutorError('INVALID_PROVIDER_PAYLOAD');
  }
  return payload;
}

function normalizeOutcome(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.status !== 'string') {
    return Object.freeze({ status: 'AMBIGUOUS', reasonCode: 'ADAPTER_RESULT_INVALID' });
  }
  if (result.status === 'CONFIRMED') {
    if (typeof result.providerInvoiceId !== 'string' ||
        typeof result.providerInvoiceNumber !== 'string') {
      return Object.freeze({ status: 'AMBIGUOUS', reasonCode: 'ADAPTER_RESULT_INVALID' });
    }
    return Object.freeze({
      status: 'CONFIRMED',
      providerInvoiceId: result.providerInvoiceId,
      providerInvoiceNumber: result.providerInvoiceNumber,
    });
  }
  if (result.status === 'FAILED' || result.status === 'AMBIGUOUS') {
    if (typeof result.reasonCode !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.reasonCode)) {
      return Object.freeze({ status: 'AMBIGUOUS', reasonCode: 'ADAPTER_RESULT_INVALID' });
    }
    return Object.freeze({ status: result.status, reasonCode: result.reasonCode });
  }
  return Object.freeze({ status: 'AMBIGUOUS', reasonCode: 'ADAPTER_RESULT_INVALID' });
}

function createProviderIssuanceExecutor({ attemptStore, adapter }) {
  if (!attemptStore || typeof attemptStore.start !== 'function' ||
      typeof attemptStore.markAmbiguous !== 'function' ||
      typeof attemptStore.markFailed !== 'function' ||
      typeof attemptStore.markConfirmed !== 'function' ||
      typeof attemptStore.get !== 'function') {
    throw new TypeError('Persistent provider attempt store required');
  }
  if (!adapter || typeof adapter.createInvoice !== 'function') {
    throw new TypeError('Injected provider adapter required');
  }

  async function execute(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,payload') {
      throw new ProviderIssuanceExecutorError('INVALID_EXECUTION_REQUEST');
    }
    const payload = validatePreparedPayload(input.payload);
    let started;
    try {
      started = await attemptStore.start({ attemptId: input.attemptId });
    } catch (error) {
      if (error instanceof ProviderIssuanceAttemptError) throw error;
      throw new ProviderIssuanceExecutorError('ATTEMPT_START_FAILED', 503);
    }

    let outcome;
    try {
      outcome = normalizeOutcome(await adapter.createInvoice(Object.freeze({
        operationKey: started.operationKey,
        provider: started.provider,
        payload,
      })));
    } catch {
      outcome = Object.freeze({ status: 'AMBIGUOUS', reasonCode: 'ADAPTER_EXCEPTION' });
    }

    if (outcome.status === 'CONFIRMED') {
      return attemptStore.markConfirmed({
        attemptId: started.id,
        providerInvoiceId: outcome.providerInvoiceId,
        providerInvoiceNumber: outcome.providerInvoiceNumber,
      });
    }
    if (outcome.status === 'FAILED') {
      return attemptStore.markFailed({
        attemptId: started.id,
        reasonCode: outcome.reasonCode,
      });
    }
    return attemptStore.markAmbiguous({
      attemptId: started.id,
      reasonCode: outcome.reasonCode,
    });
  }

  async function reconcile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,result') {
      throw new ProviderIssuanceExecutorError('INVALID_RECONCILIATION_REQUEST');
    }
    const current = await attemptStore.get({ attemptId: input.attemptId });
    if (current.state !== 'AMBIGUOUS') {
      throw new ProviderIssuanceExecutorError('AMBIGUOUS_ATTEMPT_REQUIRED', 409);
    }
    const outcome = normalizeOutcome(input.result);
    if (outcome.status === 'AMBIGUOUS') {
      throw new ProviderIssuanceExecutorError('RECONCILIATION_INCONCLUSIVE', 409);
    }
    if (outcome.status === 'CONFIRMED') {
      return attemptStore.markConfirmed({
        attemptId: current.id,
        providerInvoiceId: outcome.providerInvoiceId,
        providerInvoiceNumber: outcome.providerInvoiceNumber,
      });
    }
    return attemptStore.markFailed({
      attemptId: current.id,
      reasonCode: outcome.reasonCode,
    });
  }

  return Object.freeze({ execute, reconcile });
}

module.exports = {
  createProviderIssuanceExecutor,
  ProviderIssuanceExecutorError,
  validatePreparedProviderPayload: validatePreparedPayload,
};
