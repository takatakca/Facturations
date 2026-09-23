'use strict';

// Pure current Wave mutation contract. No token, fetch, endpoint or external I/O.
const WAVE_INVOICE_CREATE_MUTATION = `mutation FacturationsCreateInvoice($input: InvoiceCreateInput!) {
  invoiceCreate(input: $input) {
    didSucceed
    inputErrors { message code path }
    invoice {
      id
      invoiceNumber
      status
      invoiceDate
      dueDate
      customer { id }
      currency { code }
      taxTotal { value }
      total { value }
    }
  }
}`;

const WAVE_INVOICE_APPROVE_MUTATION = `mutation FacturationsApproveInvoice($input: InvoiceApproveInput!) {
  invoiceApprove(input: $input) {
    didSucceed
    inputErrors { message code path }
    invoice {
      id
      invoiceNumber
      status
      customer { id }
      currency { code }
      taxTotal { value }
      total { value }
    }
  }
}`;

const SAFE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const MONEY = /^(0|[1-9]\d*)\.\d{2}$/;
const DECIMAL = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class WaveMutationContractError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveMutationContractError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveMutationContractError(code);
  }
  return value;
}
function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
    throw new WaveMutationContractError(code);
  }
  return value.trim();
}
function cents(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new WaveMutationContractError('INVALID_CENTS');
  }
  return (value / 100).toFixed(2);
}
function quantity(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new WaveMutationContractError('INVALID_QUANTITY');
  }
  return String(value);
}
function isoDate(value, code) {
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new WaveMutationContractError(code);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) {
    throw new WaveMutationContractError(code);
  }
  return value;
}
function optionalText(value, max, code) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WaveMutationContractError(code);
  }
  return value;
}
function validatePlan(plan) {
  exactObject(plan, [
    'status', 'operation', 'businessId', 'customerId', 'currency',
    'invoiceDate', 'dueDate', 'memo', 'items', 'expected',
    'externalActionsPerformed',
  ], 'INVALID_WAVE_PLAN');
  if (plan.status !== 'READY_FOR_WAVE_ADAPTER' ||
      plan.operation !== 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY' ||
      plan.currency !== 'CAD') {
    throw new WaveMutationContractError('INVALID_WAVE_PLAN');
  }
  if (!plan.externalActionsPerformed ||
      plan.externalActionsPerformed.createInvoice !== false ||
      plan.externalActionsPerformed.approveInvoice !== false ||
      plan.externalActionsPerformed.sendInvoice !== false) {
    throw new WaveMutationContractError('WAVE_ACTION_ALREADY_PERFORMED', 409);
  }
  if (!Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 50) {
    throw new WaveMutationContractError('INVALID_WAVE_ITEMS');
  }
  exactObject(plan.expected, [
    'customerEmail', 'subtotalCents', 'taxTotalCents', 'totalCents',
  ], 'INVALID_WAVE_EXPECTED');
  for (const field of ['subtotalCents', 'taxTotalCents', 'totalCents']) cents(plan.expected[field]);
  if (typeof plan.expected.customerEmail !== 'string' ||
      plan.expected.customerEmail.length < 3 || plan.expected.customerEmail.length > 254 ||
      /[\u0000-\u001f\u007f]/u.test(plan.expected.customerEmail)) {
    throw new WaveMutationContractError('INVALID_WAVE_EXPECTED');
  }
  return plan;
}
function itemInput(item) {
  exactObject(item, [
    'productId', 'description', 'quantity', 'unitPriceCents', 'taxable', 'salesTaxIds',
  ], 'INVALID_WAVE_ITEM');
  if (typeof item.description !== 'string' || item.description.length < 1 ||
      item.description.length > 250 || /[\u0000-\u001f\u007f]/u.test(item.description)) {
    throw new WaveMutationContractError('INVALID_WAVE_DESCRIPTION');
  }
  if (typeof item.taxable !== 'boolean' || !Array.isArray(item.salesTaxIds) ||
      item.salesTaxIds.length > 3 ||
      new Set(item.salesTaxIds).size !== item.salesTaxIds.length) {
    throw new WaveMutationContractError('INVALID_WAVE_TAX_IDS');
  }
  if (!item.taxable && item.salesTaxIds.length !== 0) {
    throw new WaveMutationContractError('NON_TAXABLE_ITEM_HAS_TAXES');
  }
  const taxes = item.salesTaxIds.map(id => ({ salesTaxId: safeId(id, 'INVALID_WAVE_TAX_ID') }));
  return Object.freeze({
    productId: safeId(item.productId, 'INVALID_WAVE_PRODUCT_ID'),
    description: item.description,
    quantity: quantity(item.quantity),
    unitPrice: cents(item.unitPriceCents),
    taxes: Object.freeze(taxes),
  });
}

function buildWaveInvoiceCreateMutation(planInput) {
  const plan = validatePlan(planInput);
  const memo = optionalText(plan.memo, 1000, 'INVALID_WAVE_MEMO');
  const invoiceDate = isoDate(plan.invoiceDate, 'INVALID_WAVE_INVOICE_DATE');
  const dueDate = isoDate(plan.dueDate, 'INVALID_WAVE_DUE_DATE');
  if (dueDate < invoiceDate) throw new WaveMutationContractError('WAVE_DUE_DATE_BEFORE_INVOICE_DATE');
  const input = {
    businessId: safeId(plan.businessId, 'INVALID_WAVE_BUSINESS_ID'),
    customerId: safeId(plan.customerId, 'INVALID_WAVE_CUSTOMER_ID'),
    status: 'DRAFT',
    currency: 'CAD',
    invoiceDate,
    dueDate,
    items: Object.freeze(plan.items.map(itemInput)),
  };
  if (memo !== undefined && memo !== '') input.memo = memo;

  // Intentionally omit invoiceNumber so Wave allocates it using its current numbering rules.
  // Intentionally omit discounts: line discounts are blocked by the persisted preflight.
  return Object.freeze({
    operationName: 'FacturationsCreateInvoice',
    query: WAVE_INVOICE_CREATE_MUTATION,
    variables: Object.freeze({ input: Object.freeze(input) }),
    expected: Object.freeze({
      customerId: plan.customerId,
      currency: 'CAD',
      total: cents(plan.expected.totalCents),
      taxTotal: cents(plan.expected.taxTotalCents),
    }),
    networkPerformed: false,
  });
}

function buildWaveInvoiceApproveMutation(invoiceId) {
  const id = safeId(invoiceId, 'INVALID_WAVE_INVOICE_ID');
  return Object.freeze({
    operationName: 'FacturationsApproveInvoice',
    query: WAVE_INVOICE_APPROVE_MUTATION,
    variables: Object.freeze({ input: Object.freeze({ invoiceId: id }) }),
    expectedInvoiceId: id,
    networkPerformed: false,
  });
}

function safeInputErrors(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.slice(0, 20).map(error => Object.freeze({
    code: typeof error?.code === 'string' ? error.code.slice(0, 120) : '',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : '',
    path: Array.isArray(error?.path)
      ? Object.freeze(error.path.filter(x => typeof x === 'string').slice(0, 20))
      : Object.freeze([]),
  })));
}
function moneyValue(value, code) {
  if (typeof value !== 'string' || !MONEY.test(value)) {
    throw new WaveMutationContractError(code, 502);
  }
  return value;
}
function commonInvoice(invoice, expected, allowedStatuses) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice) ||
      typeof invoice.id !== 'string' || !SAFE_ID.test(invoice.id) ||
      typeof invoice.status !== 'string' || !allowedStatuses.includes(invoice.status) ||
      invoice.customer?.id !== expected.customerId ||
      invoice.currency?.code !== expected.currency) {
    return null;
  }
  try {
    const total = moneyValue(invoice.total?.value, 'INVALID_WAVE_TOTAL');
    const taxTotal = moneyValue(invoice.taxTotal?.value, 'INVALID_WAVE_TAX_TOTAL');
    if (total !== expected.total || taxTotal !== expected.taxTotal) return null;
  } catch {
    return null;
  }
  return invoice;
}

function classifyCreatePayload(payload, request) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !request || request.operationName !== 'FacturationsCreateInvoice') {
    throw new WaveMutationContractError('INVALID_CREATE_CLASSIFICATION');
  }
  if (Array.isArray(payload.errors) && payload.errors.length) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'GRAPHQL_ERRORS' });
  }
  const output = payload.data?.invoiceCreate;
  if (!output || typeof output !== 'object') {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'MISSING_CREATE_OUTPUT' });
  }
  const inputErrors = safeInputErrors(output.inputErrors);
  if (output.didSucceed === false) {
    return Object.freeze({
      outcome: inputErrors.length ? 'FAILED_FINAL' : 'AMBIGUOUS',
      reason: inputErrors.length ? 'INPUT_ERRORS' : 'UNCONFIRMED_CREATE_FAILURE',
      inputErrors,
    });
  }
  if (output.didSucceed !== true) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'INVALID_CREATE_SUCCESS_FLAG' });
  }
  const invoice = commonInvoice(output.invoice, request.expected, ['DRAFT']);
  if (!invoice) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'CREATE_RESULT_MISMATCH' });
  }
  return Object.freeze({
    outcome: 'CREATE_CONFIRMED_DRAFT_ONLY',
    providerInvoiceId: invoice.id,
    providerStatus: invoice.status,
    providerInvoiceNumber: typeof invoice.invoiceNumber === 'string' ? invoice.invoiceNumber : null,
    approved: false,
    emailed: false,
  });
}

function classifyApprovePayload(payload, request, expected) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !request || request.operationName !== 'FacturationsApproveInvoice' ||
      !expected || typeof expected !== 'object') {
    throw new WaveMutationContractError('INVALID_APPROVE_CLASSIFICATION');
  }
  if (Array.isArray(payload.errors) && payload.errors.length) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'GRAPHQL_ERRORS' });
  }
  const output = payload.data?.invoiceApprove;
  if (!output || typeof output !== 'object') {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'MISSING_APPROVE_OUTPUT' });
  }
  const inputErrors = safeInputErrors(output.inputErrors);
  if (output.didSucceed === false) {
    return Object.freeze({
      outcome: inputErrors.length ? 'FAILED_FINAL' : 'AMBIGUOUS',
      reason: inputErrors.length ? 'INPUT_ERRORS' : 'UNCONFIRMED_APPROVE_FAILURE',
      inputErrors,
    });
  }
  if (output.didSucceed !== true) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'INVALID_APPROVE_SUCCESS_FLAG' });
  }
  const invoice = commonInvoice(output.invoice, expected, ['SAVED']);
  if (!invoice || invoice.id !== request.expectedInvoiceId ||
      typeof invoice.invoiceNumber !== 'string' || invoice.invoiceNumber.length < 1 ||
      invoice.invoiceNumber.length > 160 || /[\u0000-\u001f\u007f]/u.test(invoice.invoiceNumber)) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'APPROVE_RESULT_MISMATCH' });
  }
  return Object.freeze({
    outcome: 'APPROVE_CONFIRMED',
    providerInvoiceId: invoice.id,
    officialInvoiceNumber: invoice.invoiceNumber,
    providerStatus: invoice.status,
    emailed: false,
  });
}

module.exports = {
  WAVE_INVOICE_CREATE_MUTATION,
  WAVE_INVOICE_APPROVE_MUTATION,
  WaveMutationContractError,
  buildWaveInvoiceCreateMutation,
  buildWaveInvoiceApproveMutation,
  classifyCreatePayload,
  classifyApprovePayload,
};
