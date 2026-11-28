'use strict';

const { ProviderIssuanceAttemptError } = require('./provider-issuance-attempt-store');
const { computeWaveProviderPlanHash } = require('./wave-issuance-preflight');

class ProviderIssuanceExecutorError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ProviderIssuanceExecutorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactKeys(input, expected) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).sort().join(',') === [...expected].sort().join(',');
}

function validatePreparedPayload(payload) {
  const topKeys = [
    'status','operation','sourceRequestHash','providerPlanHash','businessId','customerId',
    'currency','invoiceDate','dueDate','memo','items','expected','externalActionsPerformed',
  ];
  if (!exactKeys(payload, topKeys) ||
      payload.status !== 'READY_FOR_WAVE_ADAPTER' ||
      payload.operation !== 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY' ||
      payload.currency !== 'CAD' ||
      typeof payload.sourceRequestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.sourceRequestHash) ||
      typeof payload.providerPlanHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.providerPlanHash) ||
      typeof payload.businessId !== 'string' || !payload.businessId ||
      typeof payload.customerId !== 'string' || !payload.customerId ||
      typeof payload.invoiceDate !== 'string' ||
      typeof payload.dueDate !== 'string' ||
      (payload.memo !== null && typeof payload.memo !== 'string') ||
      !Array.isArray(payload.items) || payload.items.length < 1 ||
      !exactKeys(payload.expected, [
        'customerEmail','subtotalCents','taxTotalCents','totalCents',
      ]) ||
      !exactKeys(payload.externalActionsPerformed, [
        'createInvoice','approveInvoice','sendInvoice',
      ]) ||
      payload.externalActionsPerformed.createInvoice !== false ||
      payload.externalActionsPerformed.approveInvoice !== false ||
      payload.externalActionsPerformed.sendInvoice !== false) {
    throw new ProviderIssuanceExecutorError('INVALID_PROVIDER_PAYLOAD');
  }

  const items = [];
  for (const item of payload.items) {
    if (!exactKeys(item, [
      'productId','description','quantity','unitPriceCents','taxable','salesTaxIds',
    ]) ||
        typeof item.productId !== 'string' || !item.productId ||
        typeof item.description !== 'string' || !item.description ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
        !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 ||
        typeof item.taxable !== 'boolean' ||
        !Array.isArray(item.salesTaxIds) ||
        item.salesTaxIds.some(id => typeof id !== 'string' || !id)) {
      throw new ProviderIssuanceExecutorError('INVALID_PROVIDER_PAYLOAD');
    }
    items.push(Object.freeze({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxable: item.taxable,
      salesTaxIds: Object.freeze([...item.salesTaxIds]),
    }));
  }

  if (typeof payload.expected.customerEmail !== 'string' ||
      !Number.isSafeInteger(payload.expected.subtotalCents) ||
      !Number.isSafeInteger(payload.expected.taxTotalCents) ||
      !Number.isSafeInteger(payload.expected.totalCents)) {
    throw new ProviderIssuanceExecutorError('INVALID_PROVIDER_PAYLOAD');
  }

  const normalized = Object.freeze({
    status: payload.status,
    operation: payload.operation,
    sourceRequestHash: payload.sourceRequestHash,
    providerPlanHash: payload.providerPlanHash,
    businessId: payload.businessId,
    customerId: payload.customerId,
    currency: payload.currency,
    invoiceDate: payload.invoiceDate,
    dueDate: payload.dueDate,
    memo: payload.memo,
    items: Object.freeze(items),
    expected: Object.freeze({
      customerEmail: payload.expected.customerEmail,
      subtotalCents: payload.expected.subtotalCents,
      taxTotalCents: payload.expected.taxTotalCents,
      totalCents: payload.expected.totalCents,
    }),
    externalActionsPerformed: Object.freeze({
      createInvoice: false,
      approveInvoice: false,
      sendInvoice: false,
    }),
  });

  let actualPlanHash;
  try {
    actualPlanHash = computeWaveProviderPlanHash(normalized);
  } catch {
    throw new ProviderIssuanceExecutorError('INVALID_PROVIDER_PAYLOAD');
  }
  if (actualPlanHash !== normalized.providerPlanHash) {
    throw new ProviderIssuanceExecutorError('PROVIDER_PLAN_HASH_MISMATCH', 409);
  }
  return normalized;
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
      started = await attemptStore.start({
        attemptId: input.attemptId,
        requestHash: payload.sourceRequestHash,
        providerPlanHash: payload.providerPlanHash,
      });
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
