'use strict';

const DEFAULT_PORT = 3000;

function loadConfig(env = process.env) {
  const rawPort = env.PORT || String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(rawPort)) {
    throw new Error('PORT must be an integer from 0 to 65535');
  }
  const port = Number(rawPort);
  if (port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');

  const adminKey = env.TAKATAK_ADMIN_KEY || '';
  if (adminKey && adminKey.length < 32) {
    throw new Error('TAKATAK_ADMIN_KEY must contain at least 32 characters');
  }
  const databaseUrl = (env.FACTURATIONS_DATABASE_URL || '').trim();
  const businessId = (env.WAVE_BUSINESS_ID || '').trim();
  if (Boolean(databaseUrl) !== Boolean(businessId)) {
    throw new Error('FACTURATIONS_DATABASE_URL and WAVE_BUSINESS_ID must be configured together');
  }
  if (businessId.length > 200) throw new Error('WAVE_BUSINESS_ID is too long');
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('FACTURATIONS_DATABASE_URL must be a PostgreSQL URL');
  }

  // Browser login is opt-in and fails closed unless its separate encryption key,
  // a dedicated database and exact external HTTPS origin are ALL configured.
  const browserOrigin = (env.FACTURATIONS_PUBLIC_ORIGIN || '').trim();
  const totpEncryptionKeyHex = (env.FACTURATIONS_TOTP_ENCRYPTION_KEY || '').trim();
  if (Boolean(browserOrigin) !== Boolean(totpEncryptionKeyHex)) {
    throw new Error('FACTURATIONS_PUBLIC_ORIGIN and FACTURATIONS_TOTP_ENCRYPTION_KEY must be configured together');
  }
  if (browserOrigin) {
    let parsed;
    try { parsed = new URL(browserOrigin); }
    catch { throw new Error('FACTURATIONS_PUBLIC_ORIGIN must be an exact HTTPS origin'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== browserOrigin ||
        parsed.username || parsed.password || parsed.search || parsed.hash || !databaseUrl) {
      throw new Error('FACTURATIONS_PUBLIC_ORIGIN must be an exact HTTPS origin with a dedicated database');
    }
    if (!/^[a-f0-9]{64}$/i.test(totpEncryptionKeyHex)) {
      throw new Error('FACTURATIONS_TOTP_ENCRYPTION_KEY must be 32 bytes encoded as hex');
    }
  }

  return Object.freeze({
    port,
    adminKey,
    waveToken: (env.WAVE_ACCESS_TOKEN || '').trim(),
    databaseUrl,
    businessId,
    browserOrigin,
    totpEncryptionKeyHex,
  });
}

module.exports = { loadConfig };
