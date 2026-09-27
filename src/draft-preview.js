'use strict';

// This module only calculates a preview. It NEVER persists, issues, sends, or posts invoices.
const { hasUnpairedSurrogate } = require('./unicode-validation');
const MAX_TOTAL_CENTS = 1_000_000_000_000;

class DraftValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DraftValidationError';
    this.code = code;
    this.statusCode = 422;
  }
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DraftValidationError(code);
  }
  return value;
}

function text(value, max, code, required = true) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new DraftValidationError(code);
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u001f\u007f]/u.test(result) ||
      hasUnpairedSurrogate(result)) {
    throw new DraftValidationError(code);
  }
  return result || null;
}

function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DraftValidationError(code);
  }
  return value;
}

function date(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new DraftValidationError(code);
  }
  const asDate = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== value) {
    throw new DraftValidationError(code);
  }
  return value;
}

function email(value) {
  const address = text(value, 254, 'INVALID_CUSTOMER_EMAIL');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
    throw new DraftValidationError('INVALID_CUSTOMER_EMAIL');
  }
  return address;
}

function toCents(value) {
  if (value > BigInt(MAX_TOTAL_CENTS)) throw new DraftValidationError('AMOUNT_TOO_LARGE');
  return Number(value);
}

function previewDraft(payload) {
  const input = object(payload, 'INVALID_DRAFT');
  if (input.currency !== 'CAD') throw new DraftValidationError('UNSUPPORTED_CURRENCY');
  const customerInput = object(input.customer, 'INVALID_CUSTOMER');
  const customer = {
    name: text(customerInput.name, 160, 'INVALID_CUSTOMER_NAME'),
    email: email(customerInput.email),
    address: text(customerInput.address, 500, 'INVALID_CUSTOMER_ADDRESS', false),
  };
  const invoiceDate = date(input.invoiceDate, 'INVALID_INVOICE_DATE');
  const dueDate = date(input.dueDate, 'INVALID_DUE_DATE');
  if (dueDate < invoiceDate) throw new DraftValidationError('DUE_DATE_BEFORE_INVOICE_DATE');
  const notes = text(input.notes, 1000, 'INVALID_NOTES', false);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) {
    throw new DraftValidationError('INVALID_LINES');
  }
  if (!Array.isArray(input.taxes) || input.taxes.length > 3) {
    throw new DraftValidationError('INVALID_TAXES');
  }
  const taxCodes = new Set();
  const taxes = input.taxes.map((raw) => {
    const item = object(raw, 'INVALID_TAX');
    const code = text(item.code, 20, 'INVALID_TAX_CODE');
    if (!/^[A-Z0-9_-]+$/u.test(code) || taxCodes.has(code)) {
      throw new DraftValidationError('INVALID_TAX_CODE');
    }
    taxCodes.add(code);
    return {
      code,
      label: text(item.label, 80, 'INVALID_TAX_LABEL'),
      // 5000 = 5.000%; 9975 = 9.975%. No jurisdictional rate is assumed.
      rateMilliPercent: integer(item.rateMilliPercent, 0, 100000, 'INVALID_TAX_RATE'),
    };
  });
  let subtotal = 0n;
  let taxableSubtotal = 0n;
  const lines = input.lines.map((raw) => {
    const item = object(raw, 'INVALID_LINE');
    const description = text(item.description, 250, 'INVALID_DESCRIPTION');
    const quantity = integer(item.quantity, 1, 1000, 'INVALID_QUANTITY');
    const unitPriceCents = integer(item.unitPriceCents, 0, 100_000_000, 'INVALID_UNIT_PRICE');
    const gross = BigInt(quantity) * BigInt(unitPriceCents);
    const discountCents = integer(item.discountCents ?? 0, 0, Number(gross), 'INVALID_DISCOUNT');
    if (typeof item.taxable !== 'boolean') throw new DraftValidationError('INVALID_TAXABLE_FLAG');
    const net = gross - BigInt(discountCents);
    subtotal += net;
    if (item.taxable) taxableSubtotal += net;
    return { description, quantity, unitPriceCents, discountCents, taxable: item.taxable,
      lineTotalCents: toCents(net) };
  });
  const taxResults = taxes.map(({ code, label, rateMilliPercent }) => ({
    code, label, rateMilliPercent,
    // Independent taxes on same base, half-up to nearest cent. No compounding.
    amountCents: toCents((taxableSubtotal * BigInt(rateMilliPercent) + 50_000n) / 100_000n),
  }));
  const taxSum = taxResults.reduce((sum, tax) => sum + BigInt(tax.amountCents), 0n);
  return {
    status: 'PREVIEW_ONLY',
    persisted: false,
    waveSynced: false,
    emailed: false,
    currency: 'CAD',
    customer, invoiceDate, dueDate, notes, lines, taxes: taxResults,
    subtotalCents: toCents(subtotal),
    taxableSubtotalCents: toCents(taxableSubtotal),
    taxTotalCents: toCents(taxSum),
    totalCents: toCents(subtotal + taxSum),
    calculation: 'Independent taxes on taxable discounted subtotal; half-up per tax to nearest cent.',
  };
}

module.exports = { previewDraft, DraftValidationError };
