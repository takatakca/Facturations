'use strict';

const {
  WaveReconciliationReadError,
} = require('./wave-reconciliation-read-adapter');
const {
  WaveCreateConfirmationError,
} = require('./wave-create-confirmation-store');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DECIMAL = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const SAFE_NUMBER = /^[^\u0000-\u001f\u007f]{1,160}$/u;

class WaveReadonlyReconciliationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveReadonlyReconciliationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactObject(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveReadonlyReconciliationError(code);
  }
  return input;
}

function validateInput(input) {
  exactObject(input, ['authorizationId', 'draftId'], 'INVALID_RECONCILIATION_REQUEST');
  if (typeof input.authorizationId !== 'string' || !UUID.test(input.authorizationId)) {
    throw new WaveReadonlyReconciliationError('INVALID_AUTHORIZATION_ID');
  }
  if (typeof input.draftId !== 'string' || !UUID.test(input.draftId)) {
    throw new WaveReadonlyReconciliationError('INVALID_DRAFT_ID');
  }
  return Object.freeze({ authorizationId: input.authorizationId, draftId: input.draftId });
}

function validateDependencies(mappingStore, executionStore, createConfirmationStore,
  attemptStore, readAdapter) {
  if (!mappingStore || typeof mappingStore.getByAuthorization !== 'function') {
    throw new TypeError('Persisted Wave mapping store required');
  }
  if (!executionStore || typeof executionStore.prepare !== 'function' ||
      typeof executionStore.recordOutcome !== 'function' ||
      typeof executionStore.reconcileAmbiguous !== 'function') {
    throw new TypeError('Provider execution store with reconciliation required');
  }
  if (!createConfirmationStore ||
      typeof createConfirmationStore.getByExecution !== 'function' ||
      typeof createConfirmationStore.saveReconciled !== 'function') {
    throw new TypeError('Wave create confirmation reconciliation store required');
  }
  if (!attemptStore || typeof attemptStore.listCurrent !== 'function') {
    throw new TypeError('Wave network attempt store required');
  }
  if (!readAdapter || readAdapter.mode !== 'AUTHORIZED_TEST_ONLY' ||
      typeof readAdapter.getInvoiceById !== 'function' ||
      typeof readAdapter.searchInvoices !== 'function') {
    throw new TypeError('AUTHORIZED_TEST_ONLY Wave read adapter required');
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

function hasOperation(attempts, operation) {
  return attempts.some(attempt => attempt.operation === operation);
}

function cents(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new WaveReadonlyReconciliationError('INVALID_EXPECTED_CENTS');
  }
  return (value / 100).toFixed(2);
}

function decimalScaled(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const padded = (fraction + '00000000').slice(0, 8);
  return BigInt(whole) * 100000000n + BigInt(padded);
}

function quantityMatches(actual, expectedInteger) {
  const scaled = decimalScaled(actual);
  return scaled !== null && Number.isSafeInteger(expectedInteger) && expectedInteger >= 0 &&
    scaled === BigInt(expectedInteger) * 100000000n;
}

function unitPriceMatches(actual, centsValue) {
  const scaled = decimalScaled(actual);
  return scaled !== null && Number.isSafeInteger(centsValue) && centsValue >= 0 &&
    scaled === BigInt(centsValue) * 1000000n;
}

function sameIds(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    return false;
  }
  return [...actual].sort().join('\u0000') === [...expected].sort().join('\u0000');
}

function invoiceMatchesPlan(invoice, plan) {
  if (!invoice || !plan || invoice.customerId !== plan.customerId ||
      invoice.currency !== plan.currency ||
      invoice.invoiceDate !== plan.invoiceDate ||
      invoice.dueDate !== plan.dueDate ||
      invoice.total !== cents(plan.expected.totalCents) ||
      invoice.taxTotal !== cents(plan.expected.taxTotalCents) ||
      !Array.isArray(invoice.items) ||
      invoice.items.length !== plan.items.length) {
    return false;
  }
  for (let index = 0; index < plan.items.length; index++) {
    const observed = invoice.items[index];
    const expected = plan.items[index];
    if (!observed || observed.productId !== expected.productId ||
        observed.description !== expected.description ||
        !quantityMatches(observed.quantity, expected.quantity) ||
        !unitPriceMatches(observed.unitPrice, expected.unitPriceCents) ||
        !sameIds(observed.salesTaxIds, expected.salesTaxIds)) {
      return false;
    }
  }
  return true;
}

function validOfficialNumber(value) {
  return typeof value === 'string' && SAFE_NUMBER.test(value);
}

async function markCrashWindowAmbiguous(executionStore, attemptStore, execution,
  createConfirmation) {
  const attempts = await attemptStore.listCurrent(execution.id, execution.version);
  let code = null;
  if (createConfirmation && hasOperation(attempts, 'APPROVE_INVOICE')) {
    code = 'WAVE_APPROVE_RESTART_OUTCOME_UNKNOWN';
  } else if (!createConfirmation && hasOperation(attempts, 'CREATE_DRAFT')) {
    code = 'WAVE_CREATE_RESTART_OUTCOME_UNKNOWN';
  }
  if (!code) {
    throw new WaveReadonlyReconciliationError('NO_UNCERTAIN_NETWORK_ATTEMPT', 409);
  }
  return executionStore.recordOutcome({
    executionId: execution.id,
    expectedVersion: execution.version,
    outcome: 'AMBIGUOUS',
    providerInvoiceId: null,
    officialInvoiceNumber: null,
    errorCode: code,
  });
}

function inconclusive(mapping, execution, createConfirmation, reason) {
  return Object.freeze({
    status: 'RECONCILIATION_INCONCLUSIVE',
    reason,
    mappingId: mapping.id,
    execution,
    createConfirmation,
    mutationRetryAllowed: false,
    networkMutationPerformed: false,
  });
}

function reconciled(mapping, execution, createConfirmation, resolution) {
  return Object.freeze({
    status: resolution,
    mappingId: mapping.id,
    execution,
    createConfirmation,
    mutationRetryAllowed: execution.state === 'FAILED_RETRYABLE',
    networkMutationPerformed: false,
  });
}

function createWaveReadonlyReconciler({
  mappingStore,
  executionStore,
  createConfirmationStore,
  attemptStore,
  readAdapter,
}) {
  validateDependencies(mappingStore, executionStore, createConfirmationStore,
    attemptStore, readAdapter);

  async function reconcile(input) {
    const fields = validateInput(input);
    const mapping = await mappingStore.getByAuthorization(fields.authorizationId);
    if (mapping.authorizationId !== fields.authorizationId ||
        mapping.draftId !== fields.draftId) {
      throw new WaveReadonlyReconciliationError('MAPPING_CHAIN_MISMATCH', 409);
    }
    if (mapping.plan.businessId !== readAdapter.allowedBusinessId) {
      throw new WaveReadonlyReconciliationError('READ_BUSINESS_SCOPE_MISMATCH', 403);
    }

    let execution = await executionStore.prepare({
      authorizationId: fields.authorizationId,
      draftId: fields.draftId,
      provider: 'WAVE',
    });
    let createConfirmation = await optionalCreateConfirmation(
      createConfirmationStore, execution.id);

    if (execution.state === 'CONFIRMED') {
      return reconciled(mapping, execution, createConfirmation, 'ALREADY_CONFIRMED');
    }
    if (execution.state === 'FAILED_FINAL') {
      throw new WaveReadonlyReconciliationError('EXECUTION_FAILED_FINAL', 409);
    }
    if (execution.state === 'IN_PROGRESS') {
      execution = await markCrashWindowAmbiguous(
        executionStore, attemptStore, execution, createConfirmation);
    } else if (execution.state !== 'AMBIGUOUS') {
      throw new WaveReadonlyReconciliationError('RECONCILIATION_NOT_REQUIRED', 409);
    }

    if (createConfirmation) {
      let lookup;
      try {
        lookup = await readAdapter.getInvoiceById({
          businessId: mapping.plan.businessId,
          invoiceId: createConfirmation.providerInvoiceId,
        });
      } catch (error) {
        if (error instanceof WaveReconciliationReadError) {
          return inconclusive(mapping, execution, createConfirmation, error.code);
        }
        throw error;
      }

      if (lookup.kind !== 'FOUND' || !lookup.invoice) {
        return inconclusive(mapping, execution, createConfirmation, 'PROVIDER_INVOICE_NOT_FOUND_BY_ID');
      }
      if (lookup.invoice.id !== createConfirmation.providerInvoiceId ||
          !invoiceMatchesPlan(lookup.invoice, mapping.plan)) {
        execution = await executionStore.reconcileAmbiguous({
          executionId: execution.id,
          expectedVersion: execution.version,
          resolution: 'FAILED_FINAL',
          providerInvoiceId: null,
          officialInvoiceNumber: null,
          errorCode: 'WAVE_RECONCILIATION_INVOICE_MISMATCH',
        });
        return reconciled(mapping, execution, createConfirmation, 'FAILED_FINAL_MISMATCH');
      }

      if (lookup.invoice.status === 'SAVED' && validOfficialNumber(lookup.invoice.invoiceNumber)) {
        execution = await executionStore.reconcileAmbiguous({
          executionId: execution.id,
          expectedVersion: execution.version,
          resolution: 'CONFIRMED',
          providerInvoiceId: lookup.invoice.id,
          officialInvoiceNumber: lookup.invoice.invoiceNumber,
          errorCode: null,
        });
        return reconciled(mapping, execution, createConfirmation, 'APPROVAL_CONFIRMED_BY_READ');
      }

      if (lookup.invoice.status === 'DRAFT') {
        execution = await executionStore.reconcileAmbiguous({
          executionId: execution.id,
          expectedVersion: execution.version,
          resolution: 'NOT_FOUND_RETRYABLE',
          providerInvoiceId: null,
          officialInvoiceNumber: null,
          errorCode: 'WAVE_APPROVAL_NOT_OBSERVED_DRAFT_STILL_PRESENT',
        });
        return reconciled(mapping, execution, createConfirmation, 'APPROVAL_NOT_OBSERVED_RETRYABLE');
      }

      return inconclusive(mapping, execution, createConfirmation,
        'UNSUPPORTED_PROVIDER_INVOICE_STATUS');
    }

    let search;
    try {
      search = await readAdapter.searchInvoices({
        businessId: mapping.plan.businessId,
        customerId: mapping.plan.customerId,
        currency: mapping.plan.currency,
        invoiceDate: mapping.plan.invoiceDate,
      });
    } catch (error) {
      if (error instanceof WaveReconciliationReadError) {
        return inconclusive(mapping, execution, null, error.code);
      }
      throw error;
    }

    if (search.truncated) {
      return inconclusive(mapping, execution, null, 'BOUNDED_SEARCH_TRUNCATED');
    }
    const candidates = search.invoices.filter(invoice => invoiceMatchesPlan(invoice, mapping.plan));
    if (candidates.length === 0) {
      // A single negative read can be affected by provider visibility/replication delay.
      // Do not unlock CREATE retry from absence alone.
      return inconclusive(mapping, execution, null, 'BOUNDED_SEARCH_NO_EXACT_MATCH');
    }
    if (candidates.length > 1) {
      return inconclusive(mapping, execution, null, 'BOUNDED_SEARCH_MULTIPLE_EXACT_MATCHES');
    }

    const candidate = candidates[0];
    createConfirmation = await createConfirmationStore.saveReconciled({
      confirmation: 'READ_ONLY_RECONCILIATION_MATCH',
      executionId: execution.id,
      authorizationId: fields.authorizationId,
      draftId: fields.draftId,
      providerInvoiceId: candidate.id,
      providerInvoiceNumber: candidate.invoiceNumber,
    });

    if (candidate.status === 'SAVED' && validOfficialNumber(candidate.invoiceNumber)) {
      execution = await executionStore.reconcileAmbiguous({
        executionId: execution.id,
        expectedVersion: execution.version,
        resolution: 'CONFIRMED',
        providerInvoiceId: candidate.id,
        officialInvoiceNumber: candidate.invoiceNumber,
        errorCode: null,
      });
      return reconciled(mapping, execution, createConfirmation, 'CREATE_AND_APPROVAL_CONFIRMED_BY_READ');
    }

    if (candidate.status === 'DRAFT') {
      execution = await executionStore.reconcileAmbiguous({
        executionId: execution.id,
        expectedVersion: execution.version,
        resolution: 'NOT_FOUND_RETRYABLE',
        providerInvoiceId: null,
        officialInvoiceNumber: null,
        errorCode: 'WAVE_CREATE_FOUND_DRAFT_APPROVAL_PENDING',
      });
      return reconciled(mapping, execution, createConfirmation,
        'CREATE_FOUND_APPROVAL_PENDING');
    }

    return inconclusive(mapping, execution, createConfirmation,
      'UNSUPPORTED_PROVIDER_INVOICE_STATUS');
  }

  return Object.freeze({ reconcile });
}

module.exports = {
  createWaveReadonlyReconciler,
  WaveReadonlyReconciliationError,
  invoiceMatchesPlan,
};
