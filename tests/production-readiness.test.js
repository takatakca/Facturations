'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const {
  assertProductionRuntime,
  ProductionReadinessError,
} = require('../src/production-readiness');

const secret = 'ab'.repeat(32);
const adminKey = 'k'.repeat(48);

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    FACTURATIONS_DATABASE_URL: 'postgresql://db-user:synthetic-password@db.internal/facturations_staging',
    WAVE_BUSINESS_ID: 'synthetic-business',
    FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.invalid',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: secret,
    ...overrides,
  };
}

function expectCode(env, code) {
  assert.throws(
    () => assertProductionRuntime({ config: loadConfig(env), env }),
    error => error instanceof ProductionReadinessError && error.code === code
  );
}

test('production gate is not enforced outside NODE_ENV=production', () => {
  const env = {};
  assert.deepEqual(
    assertProductionRuntime({ config: loadConfig(env), env }),
    { enforced: false, ready: true }
  );
});

test('production gate accepts complete synthetic production configuration', () => {
  const env = productionEnv();
  const result = assertProductionRuntime({ config: loadConfig(env), env });
  assert.equal(result.enforced, true);
  assert.equal(result.ready, true);
  assert.ok(result.checks.includes('HTTPS_PUBLIC_ORIGIN'));
});

test('production gate fails closed without database or browser security configuration', () => {
  expectCode({ NODE_ENV: 'production', PORT: '3000' }, 'PRODUCTION_DATABASE_REQUIRED');

  const env = productionEnv({
    FACTURATIONS_PUBLIC_ORIGIN: '',
    FACTURATIONS_TOTP_ENCRYPTION_KEY: '',
  });
  expectCode(env, 'PRODUCTION_BROWSER_SECURITY_REQUIRED');
});

test('production gate rejects test database, localhost public origin and port zero', () => {
  expectCode(
    productionEnv({
      FACTURATIONS_DATABASE_URL: 'postgresql://postgres:synthetic@db.internal/facturations_test',
    }),
    'PRODUCTION_DATABASE_NAME_UNSAFE'
  );
  expectCode(
    productionEnv({ FACTURATIONS_PUBLIC_ORIGIN: 'https://localhost' }),
    'PRODUCTION_PUBLIC_ORIGIN_INVALID'
  );
  expectCode(
    productionEnv({ PORT: '0' }),
    'PRODUCTION_PORT_INVALID'
  );
});

test('production Wave token requires the server-side admin gate', () => {
  expectCode(
    productionEnv({ WAVE_ACCESS_TOKEN: 'synthetic-readonly-token' }),
    'PRODUCTION_WAVE_ADMIN_GATE_REQUIRED'
  );

  const env = productionEnv({
    WAVE_ACCESS_TOKEN: 'synthetic-readonly-token',
    TAKATAK_ADMIN_KEY: adminKey,
  });
  const result = assertProductionRuntime({ config: loadConfig(env), env });
  assert.equal(result.ready, true);
});
