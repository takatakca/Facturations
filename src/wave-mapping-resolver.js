'use strict';

const {
  readWaveCustomerMapping,
  readWaveProductMapping,
  readWaveSalesTaxMapping,
} = require('./wave-mapping-read-client');
const {
  buildWaveCreateInputFromImmutableDraft,
} = require('./wave-immutable-draft-mapper');

class WaveMappingResolverError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WaveMappingResolverError';
    this.code = code;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveMappingResolverError(code);
  }
  return value;
}

function createWaveMappingResolver({
  providerStore,
  token,
  readCustomer = readWaveCustomerMapping,
  readProduct = readWaveProductMapping,
  readSalesTax = readWaveSalesTaxMapping,
}) {
  if (!providerStore || typeof providerStore.loadAuthorizedDraft !== 'function') {
    throw new TypeError('Provider store with authorized snapshot loader required');
  }
  if (typeof token !== 'string' || !token) throw new TypeError('Wave read token required');
  if ([readCustomer, readProduct, readSalesTax].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Wave mapping read functions required');
  }

  async function resolve(input) {
    exactObject(input,
      ['authorizationId', 'businessId', 'customerId', 'productIds', 'taxIdsByCode'],
      'INVALID_MAPPING_RESOLUTION');

    if (!Array.isArray(input.productIds) || !input.taxIdsByCode ||
        typeof input.taxIdsByCode !== 'object' || Array.isArray(input.taxIdsByCode)) {
      throw new WaveMappingResolverError('INVALID_MAPPING_RESOLUTION');
    }

    const authorized = await providerStore.loadAuthorizedDraft({
      authorizationId: input.authorizationId,
    });
    const preview = authorized.draft?.preview;
    if (!preview || preview.currency !== 'CAD' || !Array.isArray(preview.lines) ||
        !Array.isArray(preview.taxes) || typeof preview.customer?.email !== 'string') {
      throw new WaveMappingResolverError('INVALID_AUTHORIZED_SNAPSHOT');
    }
    if (input.productIds.length !== preview.lines.length) {
      throw new WaveMappingResolverError('PRODUCT_MAPPING_MISMATCH');
    }

    const taxCodes = preview.taxes.map(tax => tax.code);
    const suppliedTaxCodes = Object.keys(input.taxIdsByCode).sort();
    if (suppliedTaxCodes.join(',') !== [...taxCodes].sort().join(',')) {
      throw new WaveMappingResolverError('TAX_MAPPING_MISMATCH');
    }

    const customer = await readCustomer({
      token,
      businessId: input.businessId,
      customerId: input.customerId,
    });
    if (customer.email.toLowerCase() !== preview.customer.email.toLowerCase()) {
      throw new WaveMappingResolverError('WAVE_CUSTOMER_EMAIL_MISMATCH');
    }
    if (customer.currency !== 'CAD') {
      throw new WaveMappingResolverError('WAVE_CUSTOMER_CURRENCY_MISMATCH');
    }

    const products = [];
    for (let index = 0; index < input.productIds.length; index++) {
      const product = await readProduct({
        token,
        businessId: input.businessId,
        productId: input.productIds[index],
      });
      if (!product.isSold) throw new WaveMappingResolverError('WAVE_PRODUCT_NOT_SELLABLE');
      if (product.isArchived) throw new WaveMappingResolverError('WAVE_PRODUCT_ARCHIVED');
      products.push(product);
    }

    const taxProfiles = [];
    for (const tax of preview.taxes) {
      const salesTaxId = input.taxIdsByCode[tax.code];
      if (typeof salesTaxId !== 'string' || !salesTaxId) {
        throw new WaveMappingResolverError('TAX_MAPPING_MISMATCH');
      }
      const profile = await readSalesTax({
        token,
        businessId: input.businessId,
        salesTaxId,
        forDate: preview.invoiceDate,
      });
      if (profile.code !== tax.code) throw new WaveMappingResolverError('WAVE_TAX_CODE_MISMATCH');
      if (profile.rateMilliPercent !== tax.rateMilliPercent) {
        throw new WaveMappingResolverError('WAVE_TAX_RATE_MISMATCH');
      }
      if (profile.isCompound) throw new WaveMappingResolverError('WAVE_COMPOUND_TAX_UNSUPPORTED');
      if (profile.isArchived) throw new WaveMappingResolverError('WAVE_TAX_ARCHIVED');
      taxProfiles.push(Object.freeze({
        code: tax.code,
        salesTaxId: profile.id,
        rateMilliPercent: profile.rateMilliPercent,
        isCompound: false,
      }));
    }

    const mapping = Object.freeze({
      businessId: input.businessId,
      customerId: input.customerId,
      productIds: Object.freeze([...input.productIds]),
      taxProfiles: Object.freeze(taxProfiles),
    });

    // Validate the complete mapping against the immutable snapshot before exposing it.
    buildWaveCreateInputFromImmutableDraft({
      draft: authorized.draft,
      ...mapping,
    });

    return Object.freeze({
      authorizationId: authorized.authorizationId,
      draftId: authorized.draftId,
      mapping,
      evidence: Object.freeze({
        customerModifiedAt: customer.modifiedAt,
        productModifiedAt: Object.freeze(products.map(product => product.modifiedAt)),
        taxModifiedAt: Object.freeze(taxProfiles.map((_, index) => {
          // readSalesTax evidence is intentionally not returned in mapping itself.
          return preview.taxes[index].code;
        })),
      }),
      networkMode: 'READ_ONLY',
      mutationPerformed: false,
    });
  }

  return Object.freeze({ resolve });
}

module.exports = {
  createWaveMappingResolver,
  WaveMappingResolverError,
};
