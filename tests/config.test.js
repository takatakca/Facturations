'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const base = { FACTURATIONS_DATABASE_URL: 'postgresql://localhost/facturations', WAVE_BUSINESS_ID: 'business-one' };

test('defaults to port 3000 and leaves all credentials and database absent', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, adminKey: '', waveToken: '', databaseUrl: '', businessId: '',
    browserOrigin: '', totpEncryptionKeyHex: '' });
});

test('accepts port zero, trims token and dedicated database settings', () => {
  const key = 'x'.repeat(32);
  assert.deepEqual(loadConfig({ PORT: '0', TAKATAK_ADMIN_KEY: key, WAVE_ACCESS_TOKEN: ' abc ',
    FACTURATIONS_DATABASE_URL: ' postgresql://localhost/facturations ', WAVE_BUSINESS_ID: ' business-one ' }), {
    port: 0, adminKey: key, waveToken: 'abc',
    databaseUrl: 'postgresql://localhost/facturations', businessId: 'business-one',
    browserOrigin: '', totpEncryptionKeyHex: '',
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

test('browser login requires paired strong secret, dedicated database and exact HTTPS origin', () => {
  const secret = 'ab'.repeat(32); // Synthetic fixture only.
  const valid = loadConfig({ ...base, FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: secret });
  assert.equal(valid.browserOrigin, 'https://facturations.example.test');
  assert.equal(valid.totpEncryptionKeyHex, secret);
  assert.throws(() => loadConfig({ ...base, FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test' }), /configured together/);
  assert.throws(() => loadConfig({ ...base, FACTURATIONS_TOTP_ENCRYPTION_KEY: secret }), /configured together/);
  assert.throws(() => loadConfig({ FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: secret }), /dedicated database/);
  for (const origin of ['http://facturations.example.test', 'https://facturations.example.test/path',
    'https://facturations.example.test?x=1', 'https://user:pass@facturations.example.test',
    'https://facturations.example.test/', 'not-a-url']) {
    assert.throws(() => loadConfig({ ...base, FACTURATIONS_PUBLIC_ORIGIN: origin,
      FACTURATIONS_TOTP_ENCRYPTION_KEY: secret }), /HTTPS origin/);
  }
  assert.throws(() => loadConfig({ ...base, FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: 'abc' }), /32 bytes/);
});
