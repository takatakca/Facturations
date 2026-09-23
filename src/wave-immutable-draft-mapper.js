'use strict';

const { buildWaveInvoiceCreateRequest } = require('./wave-invoice-create-contract');

class WaveDraftMappingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WaveDraftMappingError';
    this.code = code;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveDraftMappingError(code);
  }
  return value;
}

function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100_000_000) {
    throw new WaveDraftMappingError('INVALID_DRAFT_MONEY');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
      draft.status !== 'DRAFT' || !draft.preview || draft.preview.status !== 'DRAFT' ||
      draft.preview.persisted !== true || draft.preview.currency !== 'CAD' ||
      !Array.isArray(draft.preview.lines) || draft.preview.lines.length < 1 ||
      !Array.isArray(draft.preview.taxes)) {
    throw new WaveDraftMappingError('IMMUTABLE_DRAFT_REQUIRED');
  }
  return draft.preview;
}

function validateTaxProfiles(preview, profiles) {
  if (!Array.isArray(profiles) || profiles.length !== preview.taxes.length) {
    throw new WaveDraftMappingError('TAX_PROFILE_SET_MISMATCH');
  }
  const byCode = new Map();
  for (const profile of profiles) {
    exactObject(profile, ['code', 'salesTaxId', 'rateMilliPercent', 'isCompound'],
      'INVALID_TAX_PROFILE');
    if (typeof profile.code !== 'string' || typeof profile.salesTaxId !== 'string' ||
        !profile.salesTaxId || !Number.isSafeInteger(profile.rateMilliPercent) ||
        typeof profile.isCompound !== 'boolean' || byCode.has(profile.code)) {
      throw new WaveDraftMappingError('INVALID_TAX_PROFILE');
    }
    if (profile.isCompound) throw new WaveDraftMappingError('COMPOUND_TAX_MAPPING_UNSUPPORTED');
    byCode.set(profile.code, profile);
  }

  const mapped = preview.taxes.map(tax => {
    const profile = byCode.get(tax.code);
    if (!profile) throw new WaveDraftMappingError('TAX_PROFILE_SET_MISMATCH');
    if (profile.rateMilliPercent !== tax.rateMilliPercent) {
      throw new WaveDraftMappingError('TAX_RATE_MISMATCH');
    }
    const expected = Number(
      (BigInt(preview.taxableSubtotalCents) * BigInt(tax.rateMilliPercent) + 50_000n) / 100_000n
    );
    if (tax.amountCents !== expected) throw new WaveDraftMappingError('TAX_AMOUNT_MISMATCH');
    return profile.salesTaxId;
  });

  if (byCode.size !== preview.taxes.length) {
    throw new WaveDraftMappingError('TAX_PROFILE_SET_MISMATCH');
  }
  return Object.freeze(mapped);
}

function buildWaveCreateInputFromImmutableDraft(input) {
  exactObject(input, ['draft', 'businessId', 'customerId', 'productIds', 'taxProfiles'],
    'INVALID_DRAFT_MAPPING_INPUT');

  const preview = validateDraft(input.draft);
  if (!Array.isArray(input.productIds) || input.productIds.length !== preview.lines.length ||
      input.productIds.some(id => typeof id !== 'string' || !id)) {
    throw new WaveDraftMappingError('PRODUCT_MAPPING_MISMATCH');
  }

  const salesTaxIds = validateTaxProfiles(preview, input.taxProfiles);
  let subtotal = 0n;
  const items = preview.lines.map((line, index) => {
    if (!line || !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
        !Number.isSafeInteger(line.unitPriceCents) ||
        !Number.isSafeInteger(line.discountCents) || typeof line.taxable !== 'boolean') {
      throw new WaveDraftMappingError('INVALID_DRAFT_LINE');
    }
    if (line.discountCents !== 0) {
      // Wave currently accepts at most one invoice-level discount. Never collapse
      // line discounts into an approximation.
      throw new WaveDraftMappingError('LINE_DISCOUNT_MAPPING_UNSUPPORTED');
    }
    const gross = BigInt(line.quantity) * BigInt(line.unitPriceCents);
    if (Number(gross) !== line.lineTotalCents) {
      throw new WaveDraftMappingError('LINE_TOTAL_MISMATCH');
    }
    subtotal += gross;
    return Object.freeze({
      productId: input.productIds[index],
      description: line.description,
      quantity: String(line.quantity),
      unitPrice: money(line.unitPriceCents),
      salesTaxIds: line.taxable ? [...salesTaxIds] : [],
    });
  });

  if (Number(subtotal) !== preview.subtotalCents) {
    throw new WaveDraftMappingError('SUBTOTAL_MISMATCH');
  }
  const taxTotal = preview.taxes.reduce((sum, tax) => sum + BigInt(tax.amountCents), 0n);
  if (Number(taxTotal) !== preview.taxTotalCents ||
      preview.subtotalCents + preview.taxTotalCents !== preview.totalCents) {
    throw new WaveDraftMappingError('TOTAL_MISMATCH');
  }

  const waveCreateInput = Object.freeze({
    businessId: input.businessId,
    customerId: input.customerId,
    status: 'DRAFT',
    currency: 'CAD',
    invoiceDate: preview.invoiceDate,
    dueDate: preview.dueDate,
    items: Object.freeze(items),
    discounts: Object.freeze([]),
    memo: preview.notes || '',
  });

  // Reuse the provider contract as the final schema validator. Still no network.
  buildWaveInvoiceCreateRequest(waveCreateInput);
  return waveCreateInput;
}

module.exports = {
  buildWaveCreateInputFromImmutableDraft,
  WaveDraftMappingError,
};
