'use strict';

const { previewDraft, DraftValidationError } = require('./draft-preview');

class WaveIssuancePreflightError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveIssuancePreflightError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
function id(value, code) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WaveIssuancePreflightError(code);
  }
  return value.trim();
}
function immutableSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.status !== 'DRAFT' || snapshot.persisted !== true || snapshot.currency !== 'CAD' ||
      !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.taxes)) {
    throw new WaveIssuancePreflightError('IMMUTABLE_DRAFT_REQUIRED');
  }
  let recalculated;
  try {
    recalculated = previewDraft({
      currency: snapshot.currency,
      customer: snapshot.customer,
      invoiceDate: snapshot.invoiceDate,
      dueDate: snapshot.dueDate,
      notes: snapshot.notes,
      lines: snapshot.lines.map(line => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        discountCents: line.discountCents,
        taxable: line.taxable,
      })),
      taxes: snapshot.taxes.map(tax => ({
        code: tax.code,
        label: tax.label,
        rateMilliPercent: tax.rateMilliPercent,
      })),
    });
  } catch (error) {
    if (error instanceof DraftValidationError) {
      throw new WaveIssuancePreflightError('IMMUTABLE_DRAFT_INVALID');
    }
    throw error;
  }
  for (const field of ['subtotalCents','taxableSubtotalCents','taxTotalCents','totalCents']) {
    if (snapshot[field] !== recalculated[field]) {
      throw new WaveIssuancePreflightError('IMMUTABLE_TOTAL_MISMATCH', 409);
    }
  }
  if (snapshot.lines.length !== recalculated.lines.length ||
      snapshot.taxes.length !== recalculated.taxes.length) {
    throw new WaveIssuancePreflightError('IMMUTABLE_DRAFT_INVALID');
  }
  return recalculated;
}
function buildWaveIssuancePreflight(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'businessId,customerId,productIds,salesTaxes,snapshot') {
    throw new WaveIssuancePreflightError('INVALID_PREFLIGHT');
  }
  const snapshot = immutableSnapshot(input.snapshot);
  const businessId = id(input.businessId, 'WAVE_BUSINESS_ID_REQUIRED');
  const customerId = id(input.customerId, 'WAVE_CUSTOMER_ID_REQUIRED');
  if (!Array.isArray(input.productIds) || input.productIds.length !== snapshot.lines.length) {
    throw new WaveIssuancePreflightError('WAVE_PRODUCT_MAPPING_REQUIRED');
  }
  const productIds = input.productIds.map(value => id(value, 'WAVE_PRODUCT_MAPPING_REQUIRED'));
  if (!input.salesTaxes || typeof input.salesTaxes !== 'object' || Array.isArray(input.salesTaxes)) {
    throw new WaveIssuancePreflightError('WAVE_TAX_MAPPING_REQUIRED');
  }
  if (snapshot.lines.some(line => line.discountCents !== 0)) {
    throw new WaveIssuancePreflightError('WAVE_LINE_DISCOUNT_UNSUPPORTED', 409);
  }

  const taxIds = new Map();
  for (const tax of snapshot.taxes) {
    const mapping = input.salesTaxes[tax.code];
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new WaveIssuancePreflightError('WAVE_TAX_MAPPING_REQUIRED');
    }
    const salesTaxId = id(mapping.id, 'WAVE_TAX_MAPPING_REQUIRED');
    if (!Number.isSafeInteger(mapping.rateMilliPercent) ||
        mapping.rateMilliPercent !== tax.rateMilliPercent) {
      throw new WaveIssuancePreflightError('WAVE_TAX_RATE_MISMATCH', 409);
    }
    taxIds.set(tax.code, salesTaxId);
  }
  const unexpectedTaxCodes = Object.keys(input.salesTaxes).filter(code =>
    !snapshot.taxes.some(tax => tax.code === code));
  if (unexpectedTaxCodes.length) {
    throw new WaveIssuancePreflightError('WAVE_TAX_MAPPING_MISMATCH');
  }

  const appliedTaxIds = snapshot.taxes.map(tax => taxIds.get(tax.code));
  const items = snapshot.lines.map((line,index) => Object.freeze({
    productId: productIds[index],
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    taxable: line.taxable,
    salesTaxIds: line.taxable ? [...appliedTaxIds] : [],
  }));

  return Object.freeze({
    status: 'READY_FOR_WAVE_ADAPTER',
    operation: 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY',
    businessId,
    customerId,
    currency: 'CAD',
    invoiceDate: snapshot.invoiceDate,
    dueDate: snapshot.dueDate,
    memo: snapshot.notes,
    items: Object.freeze(items),
    expected: Object.freeze({
      customerEmail: snapshot.customer.email.toLowerCase(),
      subtotalCents: snapshot.subtotalCents,
      taxTotalCents: snapshot.taxTotalCents,
      totalCents: snapshot.totalCents,
    }),
    externalActionsPerformed: Object.freeze({
      createInvoice: false,
      approveInvoice: false,
      sendInvoice: false,
    }),
  });
}

module.exports = { buildWaveIssuancePreflight, WaveIssuancePreflightError };
