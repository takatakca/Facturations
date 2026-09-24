'use strict';

const { WAVE_GRAPHQL_URL } = require('./wave-network-adapter');

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SEARCH_PAGE_SIZE = 20;
const SAFE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const SAFE_TOKEN = /^[^\s\u0000-\u001f\u007f]{16,4096}$/u;
const MONEY = /^(0|[1-9]\d*)\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_ACTIVATIONS = new Set(['DISABLED', 'AUTHORIZED_TEST_ONLY']);

const WAVE_RECONCILE_INVOICE_BY_ID_QUERY = `query FacturationsReconcileInvoiceById($businessId: ID!, $invoiceId: ID!) {
  business(id: $businessId) {
    id
    invoice(id: $invoiceId) {
      id
      createdAt
      modifiedAt
      status
      invoiceNumber
      invoiceDate
      dueDate
      customer { id }
      currency { code }
      taxTotal { value }
      total { value }
    }
  }
}`;

const WAVE_RECONCILE_INVOICE_SEARCH_QUERY = `query FacturationsReconcileInvoiceSearch(
  $businessId: ID!,
  $page: Int!,
  $pageSize: Int!,
  $customerId: ID!,
  $currency: CurrencyCode!,
  $invoiceDateStart: Date!,
  $invoiceDateEnd: Date!
) {
  business(id: $businessId) {
    id
    invoices(
      page: $page,
      pageSize: $pageSize,
      customerId: $customerId,
      currency: $currency,
      invoiceDateStart: $invoiceDateStart,
      invoiceDateEnd: $invoiceDateEnd
    ) {
      pageInfo { currentPage totalPages totalCount }
      edges {
        node {
          id
          createdAt
          modifiedAt
          status
          invoiceNumber
          invoiceDate
          dueDate
          customer { id }
          currency { code }
          taxTotal { value }
          total { value }
        }
      }
    }
  }
}`;

class WaveReconciliationReadError extends Error {
  constructor(code, statusCode = 502, { retryable = false } = {}) {
    super(code);
    this.name = 'WaveReconciliationReadError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
    throw new WaveReconciliationReadError(code, 422);
  }
  return value.trim();
}

function validDate(value, code) {
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new WaveReconciliationReadError(code, 422);
  }
  return value;
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 50 ||
      scopes.some(scope => typeof scope !== 'string' || scope.length < 1 ||
        scope.length > 120 || /[\u0000-\u001f\u007f\s]/u.test(scope))) {
    throw new TypeError('Verified Wave OAuth scopes are required');
  }
  if (!scopes.includes('invoice:read') && !scopes.includes('invoice:*')) {
    throw new TypeError('Wave invoice:read or invoice:* scope is required');
  }
  return Object.freeze([...new Set(scopes)]);
}

async function readLimitedJson(response) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new WaveReconciliationReadError('WAVE_READ_INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new WaveReconciliationReadError('WAVE_READ_RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WaveReconciliationReadError) throw error;
    throw new WaveReconciliationReadError('WAVE_READ_INVALID_RESPONSE');
  } finally {
    try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
  }
}

function httpFailure(status) {
  if (status === 401) return new WaveReconciliationReadError('WAVE_READ_AUTH_FAILED', 502);
  if (status === 403) return new WaveReconciliationReadError('WAVE_READ_ACCESS_DENIED', 502);
  if (status === 429) {
    return new WaveReconciliationReadError('WAVE_READ_RATE_LIMITED', 503, { retryable: true });
  }
  if (status >= 500) {
    return new WaveReconciliationReadError('WAVE_READ_UPSTREAM_UNAVAILABLE', 503, { retryable: true });
  }
  return new WaveReconciliationReadError('WAVE_READ_REQUEST_REJECTED', 502);
}

function invoiceOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node) ||
      typeof node.id !== 'string' || !SAFE_ID.test(node.id) ||
      typeof node.status !== 'string' || node.status.length < 1 || node.status.length > 80 ||
      typeof node.invoiceDate !== 'string' || !DATE.test(node.invoiceDate) ||
      typeof node.dueDate !== 'string' || !DATE.test(node.dueDate) ||
      typeof node.customer?.id !== 'string' || !SAFE_ID.test(node.customer.id) ||
      typeof node.currency?.code !== 'string' || node.currency.code.length < 3 ||
      node.currency.code.length > 8 ||
      typeof node.total?.value !== 'string' || !MONEY.test(node.total.value) ||
      typeof node.taxTotal?.value !== 'string' || !MONEY.test(node.taxTotal.value) ||
      (node.invoiceNumber !== null && node.invoiceNumber !== undefined &&
       (typeof node.invoiceNumber !== 'string' || node.invoiceNumber.length > 160 ||
        /[\u0000-\u001f\u007f]/u.test(node.invoiceNumber)))) {
    throw new WaveReconciliationReadError('WAVE_READ_INVOICE_SHAPE_INVALID');
  }
  return Object.freeze({
    id: node.id,
    status: node.status,
    invoiceNumber: node.invoiceNumber ?? null,
    invoiceDate: node.invoiceDate,
    dueDate: node.dueDate,
    customerId: node.customer.id,
    currency: node.currency.code,
    total: node.total.value,
    taxTotal: node.taxTotal.value,
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : null,
    modifiedAt: typeof node.modifiedAt === 'string' ? node.modifiedAt : null,
  });
}

function createWaveReconciliationReadAdapter({
  activation = 'DISABLED',
  token = null,
  allowedBusinessId = null,
  grantedScopes = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!ALLOWED_ACTIVATIONS.has(activation)) {
    throw new TypeError('Wave read activation must be DISABLED or AUTHORIZED_TEST_ONLY');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new TypeError('Bounded Wave read timeout required');
  }

  if (activation === 'DISABLED') {
    return Object.freeze({
      mode: 'DISABLED',
      endpoint: WAVE_GRAPHQL_URL,
      async getInvoiceById() {
        throw new WaveReconciliationReadError('WAVE_READ_NETWORK_DISABLED', 503);
      },
      async searchInvoices() {
        throw new WaveReconciliationReadError('WAVE_READ_NETWORK_DISABLED', 503);
      },
    });
  }

  const businessId = safeId(allowedBusinessId, 'INVALID_WAVE_BUSINESS_ID');
  if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) {
    throw new TypeError('Private Wave access token required for authorized test mode');
  }
  const scopes = validateScopes(grantedScopes);
  if (typeof fetchImpl !== 'function') throw new TypeError('Wave fetch implementation required');

  async function query(queryText, variables) {
    let response;
    try {
      response = await fetchImpl(WAVE_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: queryText, variables }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new WaveReconciliationReadError(
        timeout ? 'WAVE_READ_TIMEOUT' : 'WAVE_READ_NETWORK_ERROR',
        timeout ? 504 : 502,
        { retryable: true }
      );
    }
    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      throw new WaveReconciliationReadError('WAVE_READ_INVALID_RESPONSE');
    }
    if (!response.ok) throw httpFailure(response.status);
    const payload = await readLimitedJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        (Array.isArray(payload.errors) && payload.errors.length)) {
      throw new WaveReconciliationReadError('WAVE_READ_GRAPHQL_ERROR');
    }
    const business = payload.data?.business;
    if (!business || business.id !== businessId) {
      throw new WaveReconciliationReadError('WAVE_READ_BUSINESS_MISMATCH', 409);
    }
    return business;
  }

  async function getInvoiceById(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'businessId,invoiceId') {
      throw new WaveReconciliationReadError('INVALID_INVOICE_LOOKUP', 422);
    }
    if (safeId(input.businessId, 'INVALID_WAVE_BUSINESS_ID') !== businessId) {
      throw new WaveReconciliationReadError('WAVE_BUSINESS_SCOPE_MISMATCH', 403);
    }
    const invoiceId = safeId(input.invoiceId, 'INVALID_WAVE_INVOICE_ID');
    const business = await query(WAVE_RECONCILE_INVOICE_BY_ID_QUERY, {
      businessId,
      invoiceId,
    });
    return Object.freeze({
      kind: business.invoice === null ? 'NOT_FOUND' : 'FOUND',
      invoice: business.invoice === null ? null : invoiceOf(business.invoice),
    });
  }

  async function searchInvoices(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'businessId,currency,customerId,invoiceDate') {
      throw new WaveReconciliationReadError('INVALID_INVOICE_SEARCH', 422);
    }
    if (safeId(input.businessId, 'INVALID_WAVE_BUSINESS_ID') !== businessId) {
      throw new WaveReconciliationReadError('WAVE_BUSINESS_SCOPE_MISMATCH', 403);
    }
    const customerId = safeId(input.customerId, 'INVALID_WAVE_CUSTOMER_ID');
    const currency = safeId(input.currency, 'INVALID_WAVE_CURRENCY');
    const invoiceDate = validDate(input.invoiceDate, 'INVALID_WAVE_INVOICE_DATE');
    const business = await query(WAVE_RECONCILE_INVOICE_SEARCH_QUERY, {
      businessId,
      page: 1,
      pageSize: SEARCH_PAGE_SIZE,
      customerId,
      currency,
      invoiceDateStart: invoiceDate,
      invoiceDateEnd: invoiceDate,
    });
    const connection = business.invoices;
    const pageInfo = connection?.pageInfo;
    if (!connection || !Array.isArray(connection.edges) || !pageInfo ||
        !Number.isSafeInteger(pageInfo.currentPage) || pageInfo.currentPage !== 1 ||
        !Number.isSafeInteger(pageInfo.totalPages) || pageInfo.totalPages < 0 ||
        !Number.isSafeInteger(pageInfo.totalCount) || pageInfo.totalCount < 0 ||
        connection.edges.length > SEARCH_PAGE_SIZE) {
      throw new WaveReconciliationReadError('WAVE_READ_INVOICE_LIST_SHAPE_INVALID');
    }
    const invoices = connection.edges.map(edge => invoiceOf(edge?.node));
    return Object.freeze({
      kind: 'BOUNDED_LIST',
      invoices: Object.freeze(invoices),
      totalCount: pageInfo.totalCount,
      totalPages: pageInfo.totalPages,
      truncated: pageInfo.totalPages > 1 || pageInfo.totalCount > SEARCH_PAGE_SIZE,
      pageSize: SEARCH_PAGE_SIZE,
    });
  }

  return Object.freeze({
    mode: 'AUTHORIZED_TEST_ONLY',
    endpoint: WAVE_GRAPHQL_URL,
    allowedBusinessId: businessId,
    grantedScopes: scopes,
    getInvoiceById,
    searchInvoices,
  });
}

module.exports = {
  WAVE_RECONCILE_INVOICE_BY_ID_QUERY,
  WAVE_RECONCILE_INVOICE_SEARCH_QUERY,
  WaveReconciliationReadError,
  createWaveReconciliationReadAdapter,
};
