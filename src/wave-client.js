'use strict';

// Fixed endpoint: no caller-controlled URL or GraphQL operations.
const WAVE_GRAPHQL_URL = 'https://gql.waveapps.com/graphql/public';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const BUSINESS_QUERY = `query TakatakListBusinesses {
  businesses(page: 1, pageSize: 10) {
    pageInfo { totalCount }
    edges { node { id name } }
  }
}`;

class WaveError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = 'WaveError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function readLimitedBody(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new WaveError('WAVE_INVALID_RESPONSE', 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new WaveError('WAVE_RESPONSE_TOO_LARGE', 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WaveError) throw error;
    if (error instanceof SyntaxError) {
      throw new WaveError('WAVE_INVALID_RESPONSE', 502);
    }
    throw error;
  } finally {
    // Free resources when errors stop consumption before EOF.
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
  }
}

async function listBusinesses({ token, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!token) throw new WaveError('WAVE_NOT_CONFIGURED', 503);

  let response;
  let payload;
  try {
    response = await fetchImpl(WAVE_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: BUSINESS_QUERY, variables: {} }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });

    if (response.status === 401) throw new WaveError('WAVE_AUTH_FAILED', 502);
    if (response.status === 403) throw new WaveError('WAVE_ACCESS_DENIED', 502);
    if (response.status === 429) throw new WaveError('WAVE_RATE_LIMITED', 503);
    if (!response.ok) throw new WaveError('WAVE_UPSTREAM_ERROR', 502);

    payload = await readLimitedBody(response);
  } catch (error) {
    if (error instanceof WaveError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new WaveError('WAVE_TIMEOUT', 504);
    }
    throw new WaveError('WAVE_UNAVAILABLE', 502);
  }

  // GraphQL can return HTTP 200 with errors or partially populated data.
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new WaveError('WAVE_GRAPHQL_ERROR', 502);
  }
  const connection = payload?.data?.businesses;
  if (!connection || !Array.isArray(connection.edges)) {
    throw new WaveError('WAVE_INVALID_RESPONSE', 502);
  }
  const businesses = connection.edges.map((entry) => {
    if (typeof entry?.node?.id !== 'string' || typeof entry.node.name !== 'string') {
      throw new WaveError('WAVE_INVALID_RESPONSE', 502);
    }
    return { id: entry.node.id, name: entry.node.name };
  });
  const totalCount = connection.pageInfo?.totalCount;
  if (!Number.isInteger(totalCount) || totalCount < businesses.length) {
    throw new WaveError('WAVE_INVALID_RESPONSE', 502);
  }
  return { businesses, totalCount, pageSize: 10, page: 1 };
}

module.exports = { listBusinesses, WaveError, WAVE_GRAPHQL_URL, BUSINESS_QUERY };
