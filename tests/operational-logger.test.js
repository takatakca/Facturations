'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOperationalLogger } = require('../src/operational-logger');

test('structured logger emits JSON with only allowlisted fields', () => {
  const info = [];
  const error = [];
  const logger = createOperationalLogger({
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    writeInfo: line => info.push(line),
    writeError: line => error.push(line),
  });

  logger.info('http_request', {
    requestId: '11111111-1111-4111-8111-111111111111',
    method: 'GET',
    route: '/portal/access',
    statusCode: 200,
    durationMs: 12,
    component: 'http',
    email: 'secret@example.test',
    token: 'super-secret-token',
    authorization: 'Bearer hidden',
    databaseUrl: 'postgres://hidden',
  });

  assert.equal(info.length, 1);
  assert.equal(error.length, 0);
  const payload = JSON.parse(info[0]);
  assert.deepEqual(payload, {
    ts: '2026-09-26T12:00:00.000Z',
    level: 'info',
    event: 'http_request',
    requestId: '11111111-1111-4111-8111-111111111111',
    method: 'GET',
    route: '/portal/access',
    statusCode: 200,
    durationMs: 12,
    component: 'http',
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('secret@example.test'), false);
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(serialized.includes('postgres://hidden'), false);
});

test('structured logger routes error level to stderr writer and strips controls', () => {
  const info = [];
  const error = [];
  const logger = createOperationalLogger({
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    writeInfo: line => info.push(line),
    writeError: line => error.push(line),
  });

  logger.error('database_pool_error', {
    component: 'post\ngres',
    code: 'POOL\u0000_ERROR',
  });

  assert.equal(info.length, 0);
  assert.equal(error.length, 1);
  const payload = JSON.parse(error[0]);
  assert.equal(payload.component, 'postgres');
  assert.equal(payload.code, 'POOL_ERROR');
});

test('structured logger rejects unsafe event names', () => {
  const logger = createOperationalLogger({
    writeInfo: () => {},
    writeError: () => {},
  });
  assert.throws(() => logger.info('BAD EVENT', {}), /Safe event name/);
});
