'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { once } = require('node:events');
const { readStripeRawBody, STRIPE_RAW_BODY_MAX_BYTES } = require('../src/stripe-raw-body');
const { attachStripePaymentWebhook } = require('../src/stripe-payment-webhook-route');

function incoming(headers = {}) {
  const request = new PassThrough();
  request.headers = headers;
  return request;
}

test('Stripe raw body: preserves exact signed bytes without parsing', async () => {
  const raw = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
  const request = incoming({ 'content-length': String(raw.length) });
  const body = readStripeRawBody(request);
  request.end(raw);
  assert.deepEqual(await body, raw);
});

test('Stripe raw body: rejects oversized Content-Length before consuming data', async () => {
  const request = incoming({ 'content-length': String(STRIPE_RAW_BODY_MAX_BYTES + 1) });
  try {
    await assert.rejects(readStripeRawBody(request), {
      name: 'StripeWebhookError', code: 'BODY_TOO_LARGE', statusCode: 413,
    });
  } finally {
    request.destroy();
  }
});

test('Stripe raw body: rejects chunked uploads larger than one MiB', async () => {
  const request = incoming();
  try {
    const body = readStripeRawBody(request);
    request.write(Buffer.alloc(STRIPE_RAW_BODY_MAX_BYTES, 0x61));
    request.write(Buffer.from('b'));
    await assert.rejects(body, {
      name: 'StripeWebhookError', code: 'BODY_TOO_LARGE', statusCode: 413,
    });
  } finally {
    request.destroy();
  }
});

test('Stripe raw body: aborted upload and premature close never leave pending reads', async () => {
  for (const reason of ['aborted', 'close', 'error']) {
    const request = incoming({ 'content-length': '100' });
    const body = readStripeRawBody(request);
    request.write(Buffer.from('partial'));
    if (reason === 'error') request.emit('error', new Error('synthetic transport error'));
    else request.emit(reason);
    await assert.rejects(body, {
      name: 'StripeWebhookError', code: 'BODY_READ_FAILED', statusCode: 400,
    });
    request.destroy();
  }
});

test('Stripe raw body: invalid or imprecise Content-Length is refused', async () => {
  for (const declared of ['not-a-number', '-1', '3.2', '0001', '999999999999999999999999']) {
    const request = incoming({ 'content-length': declared });
    try {
      await assert.rejects(readStripeRawBody(request), {
        name: 'StripeWebhookError', code: 'BODY_READ_FAILED', statusCode: 400,
      });
    } finally {
      request.destroy();
    }
  }
});

test('Stripe HTTP webhook: declared oversized payload returns 413 and closes connection', async () => {
  let called = false;
  const store = {
    providerKey: 'STRIPE',
    async ingestVerifiedStripe() { called = true; },
    async findIssuedInvoiceByPaymentTransaction() { called = true; return null; },
    async hasEvidenceForTransaction() { return false; },
    async recordPendingStripeReversal() { called = true; },
    async listPendingStripeReversals() { return []; },
  };
  const server = http.createServer((_request, response) => response.end('unhandled'));
  attachStripePaymentWebhook(server, {
    secret: 'whsec_' + 'syntheticsecret'.repeat(3),
    businessId: 'synthetic-business',
    evidenceStore: store,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port,
        path: '/webhooks/stripe/payments', method: 'POST',
        headers: { 'Content-Length': String(STRIPE_RAW_BODY_MAX_BYTES + 1) },
        agent: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.body), { error: 'BODY_TOO_LARGE' });
    assert.equal(called, false, 'no store call occurs before signature verification');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
