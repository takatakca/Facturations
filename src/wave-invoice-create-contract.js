'use strict';

// Pure Wave invoice-create contract. This module performs NO network request and accepts NO token.
// Schema source verified against Wave Developer Portal on 2026-09-23.
const WAVE_INVOICE_CREATE_MUTATION = `mutation FacturationsCreateInvoice($input: InvoiceCreateInput!) {
  invoiceCreate(input: $input) {
    didSucceed
    inputErrors { message code path }
    invoice { id invoiceNumber status invoiceDate dueDate }
  }
}`;

const ID = /^[A-Za-z0-9_:\-+=/]{1,500}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;

class WaveCreateContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WaveCreateContractError';
    this.code = code;
  }
}

function text(value, code, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max ||
      (!allowEmpty && value.length < 1) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WaveCreateContractError(code);
  }
  return value;
}
function waveId(value, code) {
  if (typeof value !== 'string' || !ID.test(value)) throw new WaveCreateContractError(code);
  return value;
}
function decimal(value, code, { positive = false } = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new WaveCreateContractError(code);
  if (positive && Number(value) <= 0) throw new WaveCreateContractError(code);
  return value;
}
function date(value, code) {
  if (typeof value !== 'string' || !DATE.test(value)) throw new WaveCreateContractError(code);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day) {
    throw new WaveCreateContractError(code);
  }
  return value;
}
function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveCreateContractError(code);
  }
  return value;
}
function itemOf(item) {
  exactObject(item, ['productId', 'description', 'quantity', 'unitPrice', 'salesTaxIds'], 'INVALID_WAVE_ITEM');
  if (!Array.isArray(item.salesTaxIds) || item.salesTaxIds.length > 10 ||
      new Set(item.salesTaxIds).size !== item.salesTaxIds.length) {
    throw new WaveCreateContractError('INVALID_WAVE_ITEM_TAXES');
  }
  const taxes = item.salesTaxIds.map(salesTaxId => ({ salesTaxId: waveId(salesTaxId, 'INVALID_WAVE_TAX_ID') }));
  return Object.freeze({
    productId: waveId(item.productId, 'INVALID_WAVE_PRODUCT_ID'),
    description: text(item.description, 'INVALID_WAVE_DESCRIPTION', 1000, true),
    quantity: decimal(item.quantity, 'INVALID_WAVE_QUANTITY', { positive: true }),
    unitPrice: decimal(item.unitPrice, 'INVALID_WAVE_UNIT_PRICE'),
    taxes,
  });
}
function discountOf(discount) {
  if (!discount || typeof discount !== 'object' || Array.isArray(discount)) {
    throw new WaveCreateContractError('INVALID_WAVE_DISCOUNT');
  }
  if (discount.discountType === 'FIXED') {
    exactObject(discount, ['discountType', 'name', 'amount'], 'INVALID_WAVE_DISCOUNT');
    return Object.freeze({
      discountType: 'FIXED',
      name: text(discount.name, 'INVALID_WAVE_DISCOUNT_NAME', 160, true),
      amount: decimal(discount.amount, 'INVALID_WAVE_DISCOUNT_AMOUNT'),
    });
  }
  if (discount.discountType === 'PERCENTAGE') {
    exactObject(discount, ['discountType', 'name', 'percentage'], 'INVALID_WAVE_DISCOUNT');
    const percentage = decimal(discount.percentage, 'INVALID_WAVE_DISCOUNT_PERCENTAGE');
    if (Number(percentage) > 100) throw new WaveCreateContractError('INVALID_WAVE_DISCOUNT_PERCENTAGE');
    return Object.freeze({
      discountType: 'PERCENTAGE',
      name: text(discount.name, 'INVALID_WAVE_DISCOUNT_NAME', 160, true),
      percentage,
    });
  }
  throw new WaveCreateContractError('INVALID_WAVE_DISCOUNT_TYPE');
}

function buildWaveInvoiceCreateRequest(input) {
  exactObject(input, [
    'businessId', 'customerId', 'currency', 'invoiceDate', 'dueDate',
    'items', 'discounts', 'memo', 'status',
  ], 'INVALID_WAVE_CREATE_INPUT');
  if (input.status !== 'DRAFT') throw new WaveCreateContractError('WAVE_CREATE_MUST_START_DRAFT');
  if (input.currency !== 'CAD') throw new WaveCreateContractError('UNSUPPORTED_WAVE_CURRENCY');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    throw new WaveCreateContractError('INVALID_WAVE_ITEMS');
  }
  if (!Array.isArray(input.discounts) || input.discounts.length > 1) {
    throw new WaveCreateContractError('WAVE_DISCOUNT_LIMIT_EXCEEDED');
  }
  const invoiceDate = date(input.invoiceDate, 'INVALID_WAVE_INVOICE_DATE');
  const dueDate = date(input.dueDate, 'INVALID_WAVE_DUE_DATE');
  if (dueDate < invoiceDate) throw new WaveCreateContractError('WAVE_DUE_DATE_BEFORE_INVOICE_DATE');

  const prepared = Object.freeze({
    businessId: waveId(input.businessId, 'INVALID_WAVE_BUSINESS_ID'),
    customerId: waveId(input.customerId, 'INVALID_WAVE_CUSTOMER_ID'),
    status: 'DRAFT',
    currency: 'CAD',
    invoiceDate,
    dueDate,
    items: Object.freeze(input.items.map(itemOf)),
    discounts: Object.freeze(input.discounts.map(discountOf)),
    memo: text(input.memo, 'INVALID_WAVE_MEMO', 2000, true),
  });

  return Object.freeze({
    operationName: 'FacturationsCreateInvoice',
    query: WAVE_INVOICE_CREATE_MUTATION,
    variables: Object.freeze({ input: prepared }),
    networkPerformed: false,
  });
}

function inputErrorsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(error => Object.freeze({
    code: typeof error?.code === 'string' ? error.code.slice(0, 120) : '',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : '',
    path: Array.isArray(error?.path)
      ? error.path.filter(part => typeof part === 'string').slice(0, 20)
      : [],
  }));
}

function classifyWaveInvoiceCreateResult(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.kind !== 'string') {
    throw new WaveCreateContractError('INVALID_WAVE_CREATE_EVENT');
  }
  if (event.kind === 'TIMEOUT' || event.kind === 'NETWORK_LOST_AFTER_SEND') {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: event.kind });
  }
  if (event.kind !== 'HTTP_RESPONSE' ||
      !Number.isInteger(event.status) || event.status < 100 || event.status > 599) {
    throw new WaveCreateContractError('INVALID_WAVE_CREATE_EVENT');
  }
  if (event.status === 401 || event.status === 403 || event.status === 400) {
    return Object.freeze({ outcome: 'FAILED_FINAL', reason: 'HTTP_' + event.status });
  }
  if (event.status === 429) {
    return Object.freeze({ outcome: 'FAILED_RETRYABLE', reason: 'HTTP_429' });
  }
  if (event.status >= 500) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'HTTP_' + event.status });
  }
  if (event.status !== 200 || !event.payload || typeof event.payload !== 'object' ||
      Array.isArray(event.payload)) {
    return Object.freeze({ outcome: 'FAILED_FINAL', reason: 'INVALID_HTTP_RESPONSE' });
  }

  if (Array.isArray(event.payload.errors) && event.payload.errors.length > 0) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'GRAPHQL_ERRORS' });
  }
  const output = event.payload?.data?.invoiceCreate;
  if (!output || typeof output !== 'object') {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'MISSING_MUTATION_OUTPUT' });
  }
  const errors = inputErrorsOf(output.inputErrors);
  if (output.didSucceed === false) {
    return Object.freeze({
      outcome: errors.length ? 'FAILED_FINAL' : 'AMBIGUOUS',
      reason: errors.length ? 'INPUT_ERRORS' : 'UNCONFIRMED_FAILURE',
      inputErrors: Object.freeze(errors),
    });
  }
  if (output.didSucceed !== true) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'INVALID_SUCCESS_FLAG' });
  }
  const invoice = output.invoice;
  if (!invoice || typeof invoice !== 'object' ||
      typeof invoice.id !== 'string' || invoice.id.length < 1 || invoice.id.length > 500 ||
      typeof invoice.invoiceNumber !== 'string' || invoice.invoiceNumber.length < 1 ||
      invoice.invoiceNumber.length > 120 ||
      !['DRAFT', 'SAVED'].includes(invoice.status)) {
    return Object.freeze({ outcome: 'AMBIGUOUS', reason: 'INCOMPLETE_CONFIRMED_INVOICE' });
  }
  return Object.freeze({
    outcome: 'CONFIRMED',
    providerInvoiceId: invoice.id,
    providerInvoiceNumber: invoice.invoiceNumber,
    providerStatus: invoice.status,
    reason: 'WAVE_CONFIRMED',
  });
}

module.exports = {
  WAVE_INVOICE_CREATE_MUTATION,
  WaveCreateContractError,
  buildWaveInvoiceCreateRequest,
  classifyWaveInvoiceCreateResult,
};
