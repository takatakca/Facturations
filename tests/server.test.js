'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer, isAuthorized } = require('../src/server');

const key = 'k'.repeat(64);
const demoResponse = { data: { businesses: { pageInfo: { totalCount: 1 },
  edges: [{ node: { id: 'id-1', name: 'Demo' } }] } } };

async function withServer(config, fetchImpl, run) {
  const server = createServer({ config, fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  return { response, payload: await response.json() };
}

test('constant-time verifier fails closed for absent/wrong key', () => {
  assert.equal(isAuthorized(key, key), true);
  assert.equal(isAuthorized(key + 'x', key), false);
  assert.equal(isAuthorized(undefined, key), false);
  assert.equal(isAuthorized(key, ''), false);
});

test('health is public but leaks no secrets', async () => {
  await withServer({ adminKey: key, waveToken: 'hidden-token' }, async () => { throw Error('unused'); }, async (base) => {
    const { response, payload } = await request(base, '/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(payload, { ok: true, service: 'takatak-wave', phase: 3 });
    assert.equal(JSON.stringify(payload).includes('hidden-token'), false);
  });
});

test('private route rejects missing and wrong keys without calling Wave', async () => {
  let calls = 0;
  await withServer({ adminKey: key, waveToken: 'hidden-token' }, async () => { calls++; }, async (base) => {
    for (const headers of [{}, { 'X-Admin-Key': 'bad' }]) {
      const { response, payload } = await request(base, '/api/wave/businesses', { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(payload, { error: 'UNAUTHORIZED' });
    }
    assert.equal(calls, 0);
  });
});

test('private route fails closed on missing admin configuration', async () => {
  await withServer({ adminKey: '', waveToken: 'token' }, async () => { throw Error('unused'); }, async (base) => {
    const { response, payload } = await request(base, '/api/wave/businesses');
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'ADMIN_NOT_CONFIGURED');
  });
});

test('private route reports missing Wave token only after authorization', async () => {
  await withServer({ adminKey: key, waveToken: '' }, async () => { throw Error('unused'); }, async (base) => {
    const { response, payload } = await request(base, '/api/wave/businesses', { headers: { 'X-Admin-Key': key } });
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'WAVE_NOT_CONFIGURED');
  });
});

test('authenticated route returns business summary with no caching', async () => {
  await withServer({ adminKey: key, waveToken: 'hidden-token' }, async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer hidden-token');
    return new Response(JSON.stringify(demoResponse), { status: 200 });
  }, async (base) => {
    const { response, payload } = await request(base, '/api/wave/businesses', { headers: { 'X-Admin-Key': key } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(payload, { connected: true, businesses: [{ id: 'id-1', name: 'Demo' }],
      totalCount: 1, pageSize: 10, page: 1 });
  });
});

test('GraphQL errors never appear in HTTP response', async () => {
  await withServer({ adminKey: key, waveToken: 'hidden-token' }, async () =>
    new Response(JSON.stringify({ data: demoResponse.data, errors: [{ message: 'private upstream info' }] }),
      { status: 200 }), async (base) => {
      const { response, payload } = await request(base, '/api/wave/businesses', { headers: { 'X-Admin-Key': key } });
      assert.equal(response.status, 502);
      assert.deepEqual(payload, { connected: false, error: 'WAVE_GRAPHQL_ERROR' });
    });
});

test('no OAuth, invoices, or email endpoint is exposed; unknown routes return 404', async () => {
  await withServer({ adminKey: key, waveToken: 'token' }, async () => { throw Error('unused'); }, async (base) => {
    for (const path of ['/oauth/callback', '/api/invoices', '/api/email', '/']) {
      const { response } = await request(base, path);
      assert.equal(response.status, 404);
    }
  });
});

test('write requests to protected Wave route are rejected without contacting Wave', async () => {
  let calls = 0;
  await withServer({ adminKey: key, waveToken: 'token' }, async () => { calls++; }, async (base) => {
    const { response, payload } = await request(base, '/api/wave/businesses', { method: 'POST', headers: { 'X-Admin-Key': key } });
    assert.equal(response.status, 405);
    assert.deepEqual(payload, { error: 'METHOD_NOT_ALLOWED' });
    assert.equal(calls, 0);
  });
});


test('readiness is public, fail-closed without a probe, and never exposes database errors', async () => {
  const server = createServer({
    config: { adminKey: key, waveToken: '' },
    readinessCheck: null,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let result = await request(base, '/ready');
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.payload, { ok: false, service: 'takatak-wave' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  for (const [check, expectedStatus, expectedOk] of [
    [async () => true, 200, true],
    [async () => false, 503, false],
    [async () => { throw new Error('private database detail'); }, 503, false],
  ]) {
    const readyServer = createServer({
      config: { adminKey: key, waveToken: '' },
      readinessCheck: check,
    });
    readyServer.listen(0, '127.0.0.1');
    await once(readyServer, 'listening');
    const readyBase = `http://127.0.0.1:${readyServer.address().port}`;
    try {
      const result = await request(readyBase, '/ready');
      assert.equal(result.response.status, expectedStatus);
      assert.deepEqual(result.payload, { ok: expectedOk, service: 'takatak-wave' });
      assert.equal(JSON.stringify(result.payload).includes('database'), false);
    } finally {
      await new Promise(resolve => readyServer.close(resolve));
    }
  }
});
