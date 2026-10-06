'use strict';

const DEFAULT_PORT = 3000;

function loadConfig(env = process.env) {
  const nodeEnv = (env.NODE_ENV || 'development').trim();
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test or production');
  }

  const productionMode = nodeEnv === 'production';
  const rawTrustProxy = (env.FACTURATIONS_TRUST_PROXY || '').trim();
  if (rawTrustProxy && rawTrustProxy !== '1') {
    throw new Error('FACTURATIONS_TRUST_PROXY must be 1 when enabled');
  }
  const trustProxy = rawTrustProxy === '1';

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

  const rawIntegrationEnabled = (env.FACTURATIONS_INTEGRATION_ENABLED || '').trim();
  if (rawIntegrationEnabled && rawIntegrationEnabled !== '1') {
    throw new Error('FACTURATIONS_INTEGRATION_ENABLED must be 1 when enabled');
  }
  const integrationEnabled = rawIntegrationEnabled === '1';
  const rawIntegrationWritesEnabled =
    (env.FACTURATIONS_INTEGRATION_WRITES_ENABLED || '').trim();
  if (rawIntegrationWritesEnabled && rawIntegrationWritesEnabled !== '1') {
    throw new Error('FACTURATIONS_INTEGRATION_WRITES_ENABLED must be 1 when enabled');
  }
  const integrationWritesEnabled = rawIntegrationWritesEnabled === '1';
  if (integrationWritesEnabled && !integrationEnabled) {
    throw new Error('Facturations integration writes require FACTURATIONS_INTEGRATION_ENABLED=1');
  }
  const integrationIssuer = (env.FACTURATIONS_INTEGRATION_ISSUER || '').trim();
  const integrationAudience = (env.FACTURATIONS_INTEGRATION_AUDIENCE || '').trim();
  const integrationSecret = env.FACTURATIONS_INTEGRATION_HMAC_SECRET || '';
  if (integrationEnabled) {
    if (!databaseUrl || !businessId) {
      throw new Error('Facturations integration requires dedicated database and business ID');
    }
    if (!integrationIssuer || integrationIssuer.length > 200 ||
        !integrationAudience || integrationAudience.length > 200 ||
        integrationSecret.length < 32) {
      throw new Error('Facturations integration issuer, audience and 32+ character HMAC secret are required');
    }
  } else if (integrationIssuer || integrationAudience || integrationSecret) {
    throw new Error('Facturations integration credentials require FACTURATIONS_INTEGRATION_ENABLED=1');
  }

  const stripeWebhookSecret = (env.FACTURATIONS_STRIPE_WEBHOOK_SECRET || '').trim();
  if (stripeWebhookSecret) {
    if (!databaseUrl || !businessId) {
      throw new Error('FACTURATIONS_STRIPE_WEBHOOK_SECRET requires the dedicated database and business ID');
    }
    if (!/^whsec_[A-Za-z0-9+/=_-]{24,}$/.test(stripeWebhookSecret)) {
      throw new Error('FACTURATIONS_STRIPE_WEBHOOK_SECRET must be a Stripe endpoint secret (whsec_...)');
    }
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

  if (nodeEnv === 'production') {
    if (adminKey) {
      throw new Error('Production forbids TAKATAK_ADMIN_KEY legacy shared-key access');
    }
    if (port === 0) throw new Error('Production PORT must not be zero');
    if (!databaseUrl || !businessId) {
      throw new Error('Production requires the dedicated Facturations database and business ID');
    }
    if (!browserOrigin || !totpEncryptionKeyHex) {
      throw new Error('Production requires HTTPS browser origin and TOTP encryption key');
    }
    if (!trustProxy) {
      throw new Error('Production requires FACTURATIONS_TRUST_PROXY=1 behind the dedicated HTTPS reverse proxy');
    }
    const hostname = new URL(browserOrigin).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      throw new Error('Production browser origin must not use a loopback hostname');
    }
  }

  return Object.freeze({
    nodeEnv,
    productionMode,
    trustProxy,
    port,
    adminKey,
    waveToken: (env.WAVE_ACCESS_TOKEN || '').trim(),
    databaseUrl,
    businessId,
    browserOrigin,
    totpEncryptionKeyHex,
    integrationEnabled,
    integrationWritesEnabled,
    integrationIssuer,
    integrationAudience,
    integrationSecret,
    stripeWebhookSecret,
  });
}

module.exports = { loadConfig };
