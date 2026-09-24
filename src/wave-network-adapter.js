'use strict';

const {
  WAVE_INVOICE_CREATE_MUTATION,
  WAVE_INVOICE_APPROVE_MUTATION,
} = require('./wave-mutation-contract-v2');

const WAVE_GRAPHQL_URL = 'https://gql.waveapps.com/graphql/public';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const SAFE_TOKEN = /^[^\s\u0000-\u001f\u007f]{16,4096}$/u;
const ALLOWED_ACTIVATIONS = new Set(['DISABLED', 'AUTHORIZED_TEST_ONLY']);

class WaveMutationNetworkError extends Error {
  constructor(code, statusCode = 502, { outcomeUnknown = false, retryable = false } = {}) {
    super(code);
    this.name = 'WaveMutationNetworkError';
    this.code = code;
    this.statusCode = statusCode;
    this.outcomeUnknown = outcomeUnknown;
    this.retryable = retryable;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new WaveMutationNetworkError(code, 422);
  }
  return value;
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) {
    throw new WaveMutationNetworkError(code, 422);
  }
  return value.trim();
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 50 ||
      scopes.some(scope => typeof scope !== 'string' || scope.length < 1 || scope.length > 120 ||
        /[\u0000-\u001f\u007f\s]/u.test(scope))) {
    throw new TypeError('Verified Wave OAuth scopes are required');
  }
  if (!scopes.includes('invoice:write') && !scopes.includes('invoice:*')) {
    throw new TypeError('Wave invoice:write or invoice:* scope is required');
  }
  return Object.freeze([...new Set(scopes)]);
}

function validateRequestEnvelope(input, allowedBusinessId) {
  exactObject(input, ['businessId', 'request'], 'INVALID_NETWORK_REQUEST');
  const businessId = safeId(input.businessId, 'INVALID_WAVE_BUSINESS_ID');
  if (businessId !== allowedBusinessId) {
    throw new WaveMutationNetworkError('WAVE_BUSINESS_SCOPE_MISMATCH', 403);
  }
  const request = input.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new WaveMutationNetworkError('INVALID_WAVE_MUTATION_REQUEST', 422);
  }
  if (request.networkPerformed !== false) {
    throw new WaveMutationNetworkError('MUTATION_ALREADY_MARKED_NETWORKED', 409);
  }

  if (request.operationName === 'FacturationsCreateInvoice') {
    exactObject(request,
      ['operationName', 'query', 'variables', 'expected', 'networkPerformed'],
      'INVALID_WAVE_MUTATION_REQUEST');
    if (request.query !== WAVE_INVOICE_CREATE_MUTATION) {
      throw new WaveMutationNetworkError('UNAPPROVED_GRAPHQL_OPERATION', 403);
    }
    if (request.variables?.input?.businessId !== allowedBusinessId) {
      throw new WaveMutationNetworkError('WAVE_BUSINESS_SCOPE_MISMATCH', 403);
    }
  } else if (request.operationName === 'FacturationsApproveInvoice') {
    exactObject(request,
      ['operationName', 'query', 'variables', 'expectedInvoiceId', 'networkPerformed'],
      'INVALID_WAVE_MUTATION_REQUEST');
    if (request.query !== WAVE_INVOICE_APPROVE_MUTATION) {
      throw new WaveMutationNetworkError('UNAPPROVED_GRAPHQL_OPERATION', 403);
    }
    if (request.variables?.input?.invoiceId !== request.expectedInvoiceId) {
      throw new WaveMutationNetworkError('WAVE_INVOICE_SCOPE_MISMATCH', 409);
    }
  } else {
    throw new WaveMutationNetworkError('UNAPPROVED_GRAPHQL_OPERATION', 403);
  }

  const body = JSON.stringify({ query: request.query, variables: request.variables });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new WaveMutationNetworkError('WAVE_MUTATION_REQUEST_TOO_LARGE', 413);
  }
  return Object.freeze({ businessId, request, body });
}

async function readLimitedJson(response) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new WaveMutationNetworkError('WAVE_MUTATION_INVALID_RESPONSE', 502,
      { outcomeUnknown: true });
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
        throw new WaveMutationNetworkError('WAVE_MUTATION_RESPONSE_TOO_LARGE', 502,
          { outcomeUnknown: true });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WaveMutationNetworkError) throw error;
    throw new WaveMutationNetworkError('WAVE_MUTATION_INVALID_RESPONSE', 502,
      { outcomeUnknown: true });
  } finally {
    try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
  }
}

function classifyHttpFailure(status) {
  if (status === 401) {
    return new WaveMutationNetworkError('WAVE_MUTATION_AUTH_FAILED', 502,
      { outcomeUnknown: false, retryable: false });
  }
  if (status === 403) {
    return new WaveMutationNetworkError('WAVE_MUTATION_ACCESS_DENIED', 502,
      { outcomeUnknown: false, retryable: false });
  }
  if (status === 429) {
    return new WaveMutationNetworkError('WAVE_MUTATION_RATE_LIMITED', 503,
      { outcomeUnknown: false, retryable: true });
  }
  if (status >= 400 && status < 500) {
    return new WaveMutationNetworkError('WAVE_MUTATION_REQUEST_REJECTED', 502,
      { outcomeUnknown: false, retryable: false });
  }
  return new WaveMutationNetworkError('WAVE_MUTATION_UPSTREAM_UNKNOWN', 502,
    { outcomeUnknown: true, retryable: false });
}

function createWaveNetworkAdapter({
  activation = 'DISABLED',
  token = null,
  allowedBusinessId = null,
  grantedScopes = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!ALLOWED_ACTIVATIONS.has(activation)) {
    throw new TypeError('Wave network activation must be DISABLED or AUTHORIZED_TEST_ONLY');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new TypeError('Bounded Wave network timeout required');
  }

  if (activation === 'DISABLED') {
    return Object.freeze({
      mode: 'DISABLED',
      endpoint: WAVE_GRAPHQL_URL,
      async execute() {
        throw new WaveMutationNetworkError('WAVE_NETWORK_DISABLED', 503,
          { outcomeUnknown: false, retryable: false });
      },
    });
  }

  const businessId = safeId(allowedBusinessId, 'INVALID_WAVE_BUSINESS_ID');
  if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) {
    throw new TypeError('Private Wave access token required for authorized test mode');
  }
  const scopes = validateScopes(grantedScopes);
  if (typeof fetchImpl !== 'function') throw new TypeError('Wave fetch implementation required');

  async function execute(input) {
    const envelope = validateRequestEnvelope(input, businessId);
    let response;
    try {
      response = await fetchImpl(WAVE_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: envelope.body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof WaveMutationNetworkError) throw error;
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new WaveMutationNetworkError(
        timeout ? 'WAVE_MUTATION_TIMEOUT_UNKNOWN' : 'WAVE_MUTATION_NETWORK_UNKNOWN',
        timeout ? 504 : 502,
        { outcomeUnknown: true, retryable: false }
      );
    }

    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      throw new WaveMutationNetworkError('WAVE_MUTATION_INVALID_RESPONSE', 502,
        { outcomeUnknown: true });
    }
    if (!response.ok) throw classifyHttpFailure(response.status);

    const payload = await readLimitedJson(response);
    return Object.freeze({
      operationName: envelope.request.operationName,
      payload,
      networkPerformed: true,
      endpoint: WAVE_GRAPHQL_URL,
    });
  }

  return Object.freeze({
    mode: 'AUTHORIZED_TEST_ONLY',
    endpoint: WAVE_GRAPHQL_URL,
    allowedBusinessId: businessId,
    grantedScopes: scopes,
    execute,
  });
}

module.exports = {
  WAVE_GRAPHQL_URL,
  WaveMutationNetworkError,
  createWaveNetworkAdapter,
};
