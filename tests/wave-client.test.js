'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listBusinesses, WaveError, WAVE_GRAPHQL_URL, BUSINESS_QUERY } = require('../src/wave-client');

const success = { data: { businesses: { pageInfo: { totalCount: 1 }, edges: [
  { node: { id: 'business-1', name: 'Demo business' } },
] } } };

function mockFetch(status, body, details = {}) {
  return async (url, options) => {
    assert.equal(url, WAVE_GRAPHQL_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.match(JSON.parse(options.body).query, /businesses\(page: 1, pageSize: 10\)/);
    assert.equal(JSON.parse(options.body).query, BUSINESS_QUERY);
    return new Response(details.rawBody ?? JSON.stringify(body), { status });
  };
}

async function expectError(work, code, statusCode) {
  await assert.rejects(work, (error) => error instanceof WaveError &&
    error.code === code && error.statusCode === statusCode);
}

test('retrieves the first page with a fixed Wave endpoint and query', async () => {
  assert.deepEqual(await listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, success) }), {
    businesses: [{ id: 'business-1', name: 'Demo business' }],
    totalCount: 1, pageSize: 10, page: 1,
  });
});

test('requires token without calling Wave', async () => {
  await expectError(() => listBusinesses({ token: '', fetchImpl: () => { throw Error('called'); } }),
    'WAVE_NOT_CONFIGURED', 503);
});

test('rejects failed auth and permissions without returning upstream text', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(401, { token: 'do not reveal' }) }),
    'WAVE_AUTH_FAILED', 502);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(403, {}) }),
    'WAVE_ACCESS_DENIED', 502);
});

test('handles rate limiting and upstream status failures', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(429, {}) }),
    'WAVE_RATE_LIMITED', 503);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(503, {}) }),
    'WAVE_UPSTREAM_ERROR', 502);
});

test('rejects GraphQL errors even when Wave returns HTTP 200 and partial data', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, {
    ...success, errors: [{ message: 'sensitive internal detail' }],
  }) }), 'WAVE_GRAPHQL_ERROR', 502);
});

test('rejects malformed JSON, missing data, invalid nodes or bad counts', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, {}, { rawBody: '{not-json' }) }),
    'WAVE_INVALID_RESPONSE', 502);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, { data: {} }) }),
    'WAVE_INVALID_RESPONSE', 502);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, {
    data: { businesses: { pageInfo: { totalCount: 1 }, edges: [{ node: { id: 3, name: 'X' } }] } },
  }) }), 'WAVE_INVALID_RESPONSE', 502);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, {
    data: { businesses: { pageInfo: { totalCount: 0 }, edges: success.data.businesses.edges } },
  }) }), 'WAVE_INVALID_RESPONSE', 502);
});

test('bounds the response size', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: mockFetch(200, {}, {
    rawBody: 'x'.repeat(256 * 1024 + 1),
  }) }), 'WAVE_RESPONSE_TOO_LARGE', 502);
});

test('maps connection failure and timeout without exposing original error', async () => {
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: async () => { throw Error('secret'); } }),
    'WAVE_UNAVAILABLE', 502);
  await expectError(() => listBusinesses({ token: 'test-token', fetchImpl: async () => {
    const err = new Error('timeout'); err.name = 'TimeoutError'; throw err;
  } }), 'WAVE_TIMEOUT', 504);
});
