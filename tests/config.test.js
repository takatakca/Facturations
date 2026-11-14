'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const base = { FACTURATIONS_DATABASE_URL: 'postgresql://localhost/facturations', WAVE_BUSINESS_ID: 'business-one' };

test('defaults to port 3000 and leaves all credentials and database absent', () => {
  assert.deepEqual(loadConfig({}), { nodeEnv: 'development', productionMode: false, trustProxy: false,
    port: 3000, adminKey: '', waveToken: '', databaseUrl: '', businessId: '',
    browserOrigin: '', totpEncryptionKeyHex: '', aiEnabled: false,
    openAiApiKey: '', openAiModel: '' });
});

test('accepts port zero, trims token and dedicated database settings', () => {
  const key = 'x'.repeat(32);
  assert.deepEqual(loadConfig({ PORT: '0', TAKATAK_ADMIN_KEY: key, WAVE_ACCESS_TOKEN: ' abc ',
    FACTURATIONS_DATABASE_URL: ' postgresql://localhost/facturations ', WAVE_BUSINESS_ID: ' business-one ' }), {
    nodeEnv: 'development', productionMode: false, trustProxy: false,
    port: 0, adminKey: key, waveToken: 'abc',
    databaseUrl: 'postgresql://localhost/facturations', businessId: 'business-one',
    browserOrigin: '', totpEncryptionKeyHex: '', aiEnabled: false,
    openAiApiKey: '', openAiModel: '',
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


test('production fails closed unless the dedicated database and HTTPS browser security are complete', () => {
  const secret = 'ab'.repeat(32);
  const production = {
    NODE_ENV: 'production',
    PORT: '3000',
    FACTURATIONS_DATABASE_URL: 'postgresql://db.example.test/facturations',
    WAVE_BUSINESS_ID: 'business-one',
    FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: secret,
    FACTURATIONS_TRUST_PROXY: '1',
  };
  assert.equal(loadConfig(production).browserOrigin, 'https://facturations.example.test');
  assert.equal(loadConfig(production).trustProxy, true);
  assert.throws(() => loadConfig({ ...production, FACTURATIONS_TRUST_PROXY: '' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...production, FACTURATIONS_TRUST_PROXY: 'yes' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => loadConfig({ ...production, PORT: '0' }), /Production PORT/);
  assert.throws(() => loadConfig({
    ...production,
    FACTURATIONS_PUBLIC_ORIGIN: 'https://localhost',
  }), /loopback/);
  assert.throws(() => loadConfig({ ...production, NODE_ENV: 'preview' }), /NODE_ENV/);
});


test('OpenAI help is explicit and requires private HTTPS staff configuration', () => {
  const secret = 'ab'.repeat(32);
  const env = {
    ...base,
    FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: secret,
    FACTURATIONS_AI_ENABLED: '1',
    OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789',
    FACTURATIONS_OPENAI_MODEL: 'chat-latest',
  };
  const config = loadConfig(env);
  assert.equal(config.aiEnabled, true);
  assert.equal(config.openAiApiKey, 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(config.openAiModel, 'chat-latest');

  assert.throws(() => loadConfig({
    ...base,
    FACTURATIONS_AI_ENABLED: 'yes',
  }), /AI_ENABLED/);
  assert.throws(() => loadConfig({
    ...base,
    OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789',
  }), /requires FACTURATIONS_AI_ENABLED/);
  assert.throws(() => loadConfig({
    ...base,
    FACTURATIONS_AI_ENABLED: '1',
    OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789',
    FACTURATIONS_OPENAI_MODEL: 'chat-latest',
  }), /private HTTPS staff browser service/);
  assert.throws(() => loadConfig({
    ...env,
    OPENAI_API_KEY: 'short',
  }), /OPENAI_API_KEY/);
  assert.throws(() => loadConfig({
    ...env,
    FACTURATIONS_OPENAI_MODEL: 'bad model',
  }), /FACTURATIONS_OPENAI_MODEL/);
});
