'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_CODE = /^[A-Z0-9_:-]{1,120}$/;

class WaveMappedRunnerError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveMappedRunnerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactObject(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveMappedRunnerError(code);
  }
  return input;
}
function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WaveMappedRunnerError(code);
  return value;
}
function bounded(value, max, code) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WaveMappedRunnerError(code);
  }
  return value.trim();
}
function safeCode(value, fallback) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}
function validatePlan(mapping, authorizationId, draftId) {
  if (!mapping || typeof mapping !== 'object' || mapping.authorizationId !== authorizationId ||
      mapping.draftId !== draftId || !mapping.plan || typeof mapping.plan !== 'object') {
    throw new WaveMappedRunnerError('MAPPING_MISMATCH', 409);
  }
  const plan = mapping.plan;
  if (plan.status !== 'READY_FOR_WAVE_ADAPTER' ||
      plan.operation !== 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY' ||
      plan.currency !== 'CAD' || !Array.isArray(plan.items) || plan.items.length < 1 ||
      !plan.expected || typeof plan.expected !== 'object' ||
      !plan.externalActionsPerformed ||
      plan.externalActionsPerformed.createInvoice !== false ||
      plan.externalActionsPerformed.approveInvoice !== false ||
      plan.externalActionsPerformed.sendInvoice !== false) {
    throw new WaveMappedRunnerError('INVALID_PERSISTED_WAVE_PLAN', 409);
  }
  bounded(plan.businessId, 512, 'INVALID_PERSISTED_WAVE_PLAN');
  bounded(plan.customerId, 512, 'INVALID_PERSISTED_WAVE_PLAN');
  bounded(plan.expected.customerEmail, 254, 'INVALID_PERSISTED_WAVE_PLAN');
  for (const key of ['subtotalCents', 'taxTotalCents', 'totalCents']) {
    if (!Number.isSafeInteger(plan.expected[key]) || plan.expected[key] < 0 ||
        plan.expected[key] > 1_000_000_000_000) {
      throw new WaveMappedRunnerError('INVALID_PERSISTED_WAVE_PLAN', 409);
    }
  }
  return plan;
}
function validateDependencies(mappingStore, executionStore, adapter) {
  if (!mappingStore || typeof mappingStore.getByAuthorization !== 'function') {
    throw new TypeError('Persisted Wave mapping store required');
  }
  if (!executionStore || typeof executionStore.prepare !== 'function' ||
      typeof executionStore.begin !== 'function' ||
      typeof executionStore.recordOutcome !== 'function' ||
      typeof executionStore.reconcileAmbiguous !== 'function' ||
      typeof executionStore.get !== 'function') {
    throw new TypeError('Provider execution store required');
  }
  if (!adapter || adapter.mode !== 'SIMULATED_ONLY' ||
      typeof adapter.issue !== 'function' || typeof adapter.reconcile !== 'function') {
    throw new TypeError('SIMULATED_ONLY Wave adapter required');
  }
}
function validateExecute(input) {
  exactObject(input, ['authorizationId', 'draftId'], 'INVALID_EXECUTION_REQUEST');
  return Object.freeze({
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    draftId: uuid(input.draftId, 'INVALID_DRAFT_ID'),
  });
}
function validateReconcile(input) {
  exactObject(input, ['authorizationId', 'executionId'], 'INVALID_RECONCILIATION_REQUEST');
  return Object.freeze({
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
  });
}
function normalizeConfirmed(result, plan) {
  exactObject(result, [
    'kind', 'providerInvoiceId', 'officialInvoiceNumber',
    'customerId', 'currency', 'totalCents', 'taxTotalCents',
  ], 'INVALID_SIMULATED_RESULT');
  if (result.kind !== 'CONFIRMED') throw new WaveMappedRunnerError('INVALID_SIMULATED_RESULT', 502);
  const providerInvoiceId = bounded(result.providerInvoiceId, 512, 'INVALID_SIMULATED_RESULT');
  const officialInvoiceNumber = bounded(result.officialInvoiceNumber, 160, 'INVALID_SIMULATED_RESULT');
  if (result.currency !== 'CAD' || result.customerId !== plan.customerId ||
      result.totalCents !== plan.expected.totalCents ||
      result.taxTotalCents !== plan.expected.taxTotalCents) {
    return Object.freeze({ matches: false, providerInvoiceId: null, officialInvoiceNumber: null });
  }
  return Object.freeze({ matches: true, providerInvoiceId, officialInvoiceNumber });
}
function normalizeFailure(result) {
  exactObject(result, ['kind', 'code'], 'INVALID_SIMULATED_RESULT');
  if (!['AMBIGUOUS', 'FAILED_RETRYABLE', 'FAILED_FINAL'].includes(result.kind) ||
      typeof result.code !== 'string' || !SAFE_CODE.test(result.code)) {
    throw new WaveMappedRunnerError('INVALID_SIMULATED_RESULT', 502);
  }
  return result;
}

function createWaveMappedSimulatedRunner({ mappingStore, executionStore, adapter }) {
  validateDependencies(mappingStore, executionStore, adapter);

  async function execute(input) {
    const fields = validateExecute(input);
    const mapping = await mappingStore.getByAuthorization(fields.authorizationId);
    const plan = validatePlan(mapping, fields.authorizationId, fields.draftId);
    const prepared = await executionStore.prepare({
      authorizationId: fields.authorizationId,
      draftId: fields.draftId,
      provider: 'WAVE',
    });
    const started = await executionStore.begin({
      executionId: prepared.id,
      expectedVersion: prepared.version,
    });

    let simulated;
    try {
      simulated = await adapter.issue(Object.freeze({
        operationKey: started.operationKey,
        plan,
      }));
    } catch (error) {
      const outcome = await executionStore.recordOutcome({
        executionId: started.id,
        expectedVersion: started.version,
        outcome: 'AMBIGUOUS',
        providerInvoiceId: null,
        officialInvoiceNumber: null,
        errorCode: safeCode(error?.code, 'SIMULATED_WAVE_UNKNOWN_RESULT'),
      });
      return Object.freeze({ mappingId: mapping.id, execution: outcome, simulated: true });
    }

    if (simulated?.kind === 'CONFIRMED') {
      let confirmed;
      try {
        confirmed = normalizeConfirmed(simulated, plan);
      } catch (error) {
        if (!(error instanceof WaveMappedRunnerError)) throw error;
        const outcome = await executionStore.recordOutcome({
          executionId: started.id,
          expectedVersion: started.version,
          outcome: 'AMBIGUOUS',
          providerInvoiceId: null,
          officialInvoiceNumber: null,
          errorCode: 'SIMULATED_WAVE_INVALID_RESULT',
        });
        return Object.freeze({ mappingId: mapping.id, execution: outcome, simulated: true });
      }
      const outcome = await executionStore.recordOutcome({
        executionId: started.id,
        expectedVersion: started.version,
        outcome: confirmed.matches ? 'CONFIRMED' : 'AMBIGUOUS',
        providerInvoiceId: confirmed.matches ? confirmed.providerInvoiceId : null,
        officialInvoiceNumber: confirmed.matches ? confirmed.officialInvoiceNumber : null,
        errorCode: confirmed.matches ? null : 'SIMULATED_WAVE_RESULT_MISMATCH',
      });
      return Object.freeze({ mappingId: mapping.id, execution: outcome, simulated: true });
    }

    let failure;
    try {
      failure = normalizeFailure(simulated);
    } catch (error) {
      if (!(error instanceof WaveMappedRunnerError)) throw error;
      failure = { kind: 'AMBIGUOUS', code: 'SIMULATED_WAVE_INVALID_RESULT' };
    }
    const outcome = await executionStore.recordOutcome({
      executionId: started.id,
      expectedVersion: started.version,
      outcome: failure.kind,
      providerInvoiceId: null,
      officialInvoiceNumber: null,
      errorCode: failure.code,
    });
    return Object.freeze({ mappingId: mapping.id, execution: outcome, simulated: true });
  }

  async function reconcile(input) {
    const fields = validateReconcile(input);
    const [mapping, execution] = await Promise.all([
      mappingStore.getByAuthorization(fields.authorizationId),
      executionStore.get(fields.executionId),
    ]);
    if (execution.authorizationId !== fields.authorizationId ||
        execution.draftId !== mapping.draftId || execution.provider !== 'WAVE') {
      throw new WaveMappedRunnerError('RECONCILIATION_CHAIN_MISMATCH', 409);
    }
    const plan = validatePlan(mapping, fields.authorizationId, execution.draftId);
    if (execution.state !== 'AMBIGUOUS') {
      throw new WaveMappedRunnerError('RECONCILIATION_NOT_REQUIRED', 409);
    }

    let result;
    try {
      result = await adapter.reconcile(Object.freeze({
        operationKey: execution.operationKey,
        plan,
      }));
    } catch (error) {
      throw new WaveMappedRunnerError(
        safeCode(error?.code, 'SIMULATED_WAVE_RECONCILIATION_UNAVAILABLE'), 503);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new WaveMappedRunnerError('INVALID_SIMULATED_RECONCILIATION', 502);
    }
    if (result.kind === 'FOUND') {
      const confirmedInput = { ...result, kind: 'CONFIRMED' };
      delete confirmedInput.kind;
      const normalized = normalizeConfirmed({
        kind: 'CONFIRMED',
        providerInvoiceId: result.providerInvoiceId,
        officialInvoiceNumber: result.officialInvoiceNumber,
        customerId: result.customerId,
        currency: result.currency,
        totalCents: result.totalCents,
        taxTotalCents: result.taxTotalCents,
      }, plan);
      if (!normalized.matches) {
        throw new WaveMappedRunnerError('SIMULATED_WAVE_RECONCILIATION_MISMATCH', 409);
      }
      const reconciled = await executionStore.reconcileAmbiguous({
        executionId: execution.id,
        expectedVersion: execution.version,
        resolution: 'CONFIRMED',
        providerInvoiceId: normalized.providerInvoiceId,
        officialInvoiceNumber: normalized.officialInvoiceNumber,
        errorCode: null,
      });
      return Object.freeze({ mappingId: mapping.id, execution: reconciled, simulated: true });
    }
    if (result.kind === 'NOT_FOUND') {
      exactObject(result, ['kind'], 'INVALID_SIMULATED_RECONCILIATION');
      const reconciled = await executionStore.reconcileAmbiguous({
        executionId: execution.id,
        expectedVersion: execution.version,
        resolution: 'NOT_FOUND_RETRYABLE',
        providerInvoiceId: null,
        officialInvoiceNumber: null,
        errorCode: 'SIMULATED_WAVE_RECONCILED_NOT_FOUND',
      });
      return Object.freeze({ mappingId: mapping.id, execution: reconciled, simulated: true });
    }
    if (result.kind === 'FAILED_FINAL') {
      exactObject(result, ['kind', 'code'], 'INVALID_SIMULATED_RECONCILIATION');
      if (typeof result.code !== 'string' || !SAFE_CODE.test(result.code)) {
        throw new WaveMappedRunnerError('INVALID_SIMULATED_RECONCILIATION', 502);
      }
      const reconciled = await executionStore.reconcileAmbiguous({
        executionId: execution.id,
        expectedVersion: execution.version,
        resolution: 'FAILED_FINAL',
        providerInvoiceId: null,
        officialInvoiceNumber: null,
        errorCode: result.code,
      });
      return Object.freeze({ mappingId: mapping.id, execution: reconciled, simulated: true });
    }
    if (result.kind === 'UNKNOWN') {
      exactObject(result, ['kind', 'code'], 'INVALID_SIMULATED_RECONCILIATION');
      throw new WaveMappedRunnerError(safeCode(result.code, 'SIMULATED_WAVE_RECONCILIATION_UNKNOWN'), 503);
    }
    throw new WaveMappedRunnerError('INVALID_SIMULATED_RECONCILIATION', 502);
  }

  return Object.freeze({ execute, reconcile });
}

module.exports = {
  createWaveMappedSimulatedRunner,
  WaveMappedRunnerError,
};
