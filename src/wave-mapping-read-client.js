'use strict';

const WAVE_GRAPHQL_URL = 'https://gql.waveapps.com/graphql/public';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9_:\-+=/]{1,500}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const CUSTOMER_QUERY = `query FacturationsCustomerMapping($businessId: ID!, $customerId: ID!) {
  business(id: $businessId) {
    id
    customer(id: $customerId) {
      id
      name
      email
      modifiedAt
      currency { code }
    }
  }
}`;

const PRODUCT_QUERY = `query FacturationsProductMapping($businessId: ID!, $productId: ID!) {
  business(id: $businessId) {
    id
    product(id: $productId) {
      id
      name
      unitPrice
      isSold
      isArchived
      modifiedAt
    }
  }
}`;

const SALES_TAX_QUERY = `query FacturationsSalesTaxMapping($businessId: ID!, $salesTaxId: ID!, $forDate: Date!) {
  business(id: $businessId) {
    id
    salesTax(id: $salesTaxId) {
      id
      abbreviation
      rate(for: $forDate)
      isCompound
      isArchived
      modifiedAt
    }
  }
}`;

class WaveMappingReadError extends Error {
  constructor(code, statusCode = 502) {
    super(code);
    this.name = 'WaveMappingReadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function waveId(value, code) {
  if (typeof value !== 'string' || !ID.test(value)) throw new WaveMappingReadError(code, 422);
  return value;
}

function isoDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new WaveMappingReadError('INVALID_MAPPING_DATE', 422);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new WaveMappingReadError('INVALID_MAPPING_DATE', 422);
  }
  return value;
}

function waveRateToMilliPercent(value) {
  if (typeof value !== 'string' || !/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value)) {
    throw new WaveMappingReadError('UNSUPPORTED_WAVE_TAX_RATE');
  }
  const [whole, fraction = ''] = value.split('.');
  const millionths = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  // Internal model supports 0.001 percentage points. Wave may expose 6 decimal
  // places on the fractional rate; refuse values that cannot be represented exactly.
  if (millionths % 10 !== 0) {
    throw new WaveMappingReadError('WAVE_TAX_RATE_PRECISION_MISMATCH');
  }
  return millionths / 10;
}

async function readLimitedJson(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new WaveMappingReadError('WAVE_INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new WaveMappingReadError('WAVE_RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WaveMappingReadError) throw error;
    throw new WaveMappingReadError('WAVE_INVALID_RESPONSE');
  } finally {
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
  }
}

async function postFixedQuery({ token, query, variables, fetchImpl, timeoutMs }) {
  if (typeof token !== 'string' || token.length < 1) {
    throw new WaveMappingReadError('WAVE_NOT_CONFIGURED', 503);
  }
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw new WaveMappingReadError('WAVE_UNAVAILABLE', 503);
  let response;
  try {
    response = await fetcher(WAVE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new WaveMappingReadError('WAVE_TIMEOUT', 504);
    }
    throw new WaveMappingReadError('WAVE_UNAVAILABLE', 502);
  }
  if (response.status === 401) throw new WaveMappingReadError('WAVE_AUTH_FAILED', 502);
  if (response.status === 403) throw new WaveMappingReadError('WAVE_ACCESS_DENIED', 502);
  if (response.status === 429) throw new WaveMappingReadError('WAVE_RATE_LIMITED', 503);
  if (!response.ok) throw new WaveMappingReadError('WAVE_UPSTREAM_ERROR', 502);
  const payload = await readLimitedJson(response);
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new WaveMappingReadError('WAVE_GRAPHQL_ERROR', 502);
  }
  return payload;
}

function businessNode(payload, expectedBusinessId) {
  const business = payload?.data?.business;
  if (!business || business.id !== expectedBusinessId) {
    throw new WaveMappingReadError('WAVE_BUSINESS_MISMATCH');
  }
  return business;
}

async function readWaveCustomerMapping({
  token, businessId, customerId, fetchImpl, timeoutMs,
}) {
  const business = waveId(businessId, 'INVALID_WAVE_BUSINESS_ID');
  const customer = waveId(customerId, 'INVALID_WAVE_CUSTOMER_ID');
  const payload = await postFixedQuery({
    token,
    query: CUSTOMER_QUERY,
    variables: { businessId: business, customerId: customer },
    fetchImpl,
    timeoutMs,
  });
  const node = businessNode(payload, business).customer;
  if (!node || node.id !== customer || typeof node.name !== 'string' ||
      typeof node.email !== 'string' || typeof node.modifiedAt !== 'string' ||
      typeof node.currency?.code !== 'string') {
    throw new WaveMappingReadError('WAVE_CUSTOMER_MISMATCH');
  }
  return Object.freeze({
    businessId: business,
    id: node.id,
    name: node.name,
    email: node.email,
    currency: node.currency.code,
    modifiedAt: node.modifiedAt,
  });
}

async function readWaveProductMapping({
  token, businessId, productId, fetchImpl, timeoutMs,
}) {
  const business = waveId(businessId, 'INVALID_WAVE_BUSINESS_ID');
  const product = waveId(productId, 'INVALID_WAVE_PRODUCT_ID');
  const payload = await postFixedQuery({
    token,
    query: PRODUCT_QUERY,
    variables: { businessId: business, productId: product },
    fetchImpl,
    timeoutMs,
  });
  const node = businessNode(payload, business).product;
  if (!node || node.id !== product || typeof node.name !== 'string' ||
      typeof node.unitPrice !== 'string' || typeof node.isSold !== 'boolean' ||
      typeof node.isArchived !== 'boolean' || typeof node.modifiedAt !== 'string') {
    throw new WaveMappingReadError('WAVE_PRODUCT_MISMATCH');
  }
  return Object.freeze({
    businessId: business,
    id: node.id,
    name: node.name,
    unitPrice: node.unitPrice,
    isSold: node.isSold,
    isArchived: node.isArchived,
    modifiedAt: node.modifiedAt,
  });
}

async function readWaveSalesTaxMapping({
  token, businessId, salesTaxId, forDate, fetchImpl, timeoutMs,
}) {
  const business = waveId(businessId, 'INVALID_WAVE_BUSINESS_ID');
  const tax = waveId(salesTaxId, 'INVALID_WAVE_TAX_ID');
  const date = isoDate(forDate);
  const payload = await postFixedQuery({
    token,
    query: SALES_TAX_QUERY,
    variables: { businessId: business, salesTaxId: tax, forDate: date },
    fetchImpl,
    timeoutMs,
  });
  const node = businessNode(payload, business).salesTax;
  if (!node || node.id !== tax || typeof node.abbreviation !== 'string' ||
      typeof node.rate !== 'string' || typeof node.isCompound !== 'boolean' ||
      typeof node.isArchived !== 'boolean' || typeof node.modifiedAt !== 'string') {
    throw new WaveMappingReadError('WAVE_TAX_MISMATCH');
  }
  return Object.freeze({
    businessId: business,
    id: node.id,
    code: node.abbreviation,
    rateMilliPercent: waveRateToMilliPercent(node.rate),
    isCompound: node.isCompound,
    isArchived: node.isArchived,
    modifiedAt: node.modifiedAt,
    forDate: date,
  });
}

module.exports = {
  WAVE_GRAPHQL_URL,
  CUSTOMER_QUERY,
  PRODUCT_QUERY,
  SALES_TAX_QUERY,
  WaveMappingReadError,
  waveRateToMilliPercent,
  readWaveCustomerMapping,
  readWaveProductMapping,
  readWaveSalesTaxMapping,
};
