'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('defaults to port 3000 and leaves all credentials and database absent', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, adminKey: '', waveToken: '', databaseUrl: '', businessId: '' });
});

test('accepts port zero, trims token and dedicated database settings', () => {
  const key = 'x'.repeat(32);
  assert.deepEqual(loadConfig({ PORT: '0', TAKATAK_ADMIN_KEY: key, WAVE_ACCESS_TOKEN: ' abc ',
    FACTURATIONS_DATABASE_URL: ' postgresql://localhost/facturations ', WAVE_BUSINESS_ID: ' business-one ' }), {
    port: 0, adminKey: key, waveToken: 'abc',
    databaseUrl: 'postgresql://localhost/facturations', businessId: 'business-one',
  });
});

test('rejects invalid ports, weak admin keys and incomplete database configuration', () => {
  for (const port of ['-1', 'abc', '65536', '3.5', ' 3']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ TAKATAK_ADMIN_KEY: 'short' }), /TAKATAK_ADMIN_KEY/);
  assert.throws(() => loadConfig({ FACTURATIONS_DATABASE_URL: 'postgres://localhost/test' }), /WAVE_BUSINESS_ID/);
  assert.throws(() => loadConfig({ WAVE_BUSINESS_ID: 'one' }), /FACTURATIONS_DATABASE_URL/);
  assert.throws(() => loadConfig({ FACTURATIONS_DATABASE_URL: 'https://example.test', WAVE_BUSINESS_ID: 'one' }), /PostgreSQL/);
});
