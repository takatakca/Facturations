'use strict';

class ProductionReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionReadinessError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProductionReadinessError(code);
}

function assertProductionRuntime({ config, env = process.env } = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('Config required');
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'production') {
    return Object.freeze({ enforced: false, ready: true });
  }

  if (!config.databaseUrl || !config.businessId) fail('PRODUCTION_DATABASE_REQUIRED');
  if (!config.browserOrigin || !config.totpEncryptionKeyHex) {
    fail('PRODUCTION_BROWSER_SECURITY_REQUIRED');
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    fail('PRODUCTION_PORT_INVALID');
  }

  let database;
  try { database = new URL(config.databaseUrl); }
  catch { fail('PRODUCTION_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    fail('PRODUCTION_DATABASE_URL_INVALID');
  }
  if (!database.pathname || database.pathname === '/' || database.pathname === '/facturations_test') {
    fail('PRODUCTION_DATABASE_NAME_UNSAFE');
  }

  let origin;
  try { origin = new URL(config.browserOrigin); }
  catch { fail('PRODUCTION_PUBLIC_ORIGIN_INVALID'); }
  if (origin.protocol !== 'https:' || origin.origin !== config.browserOrigin ||
      ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) {
    fail('PRODUCTION_PUBLIC_ORIGIN_INVALID');
  }

  if (!/^[a-f0-9]{64}$/i.test(config.totpEncryptionKeyHex)) {
    fail('PRODUCTION_TOTP_KEY_INVALID');
  }

  if (config.waveToken && !config.adminKey) {
    fail('PRODUCTION_WAVE_ADMIN_GATE_REQUIRED');
  }

  return Object.freeze({
    enforced: true,
    ready: true,
    checks: Object.freeze([
      'DEDICATED_DATABASE_CONFIGURED',
      'NON_TEST_DATABASE_NAME',
      'HTTPS_PUBLIC_ORIGIN',
      'TOTP_ENCRYPTION_KEY',
      'NONZERO_LISTEN_PORT',
      'WAVE_ADMIN_GATE_IF_TOKEN_PRESENT',
    ]),
  });
}

module.exports = { assertProductionRuntime, ProductionReadinessError };
