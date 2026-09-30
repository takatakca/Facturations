'use strict';

const crypto = require('node:crypto');

class IntegrationReplayError extends Error {
  constructor(code, statusCode = 401) {
    super(code);
    this.name = 'IntegrationReplayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createIntegrationReplayGuard({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function consume({ jti, expiresAt }) {
    if (typeof jti !== 'string' || jti.length < 16 || jti.length > 128 ||
        !Number.isInteger(expiresAt)) {
      throw new IntegrationReplayError('INVALID_INTEGRATION_REPLAY_INPUT');
    }

    const digest = crypto.createHash('sha256').update(jti, 'utf8').digest();
    let result;
    try {
      result = await pool.query(
        `INSERT INTO facturations_integration_token_uses
           (business_id, jti_hash, expires_at)
         VALUES ($1, $2, to_timestamp($3))
         ON CONFLICT (business_id, jti_hash) DO NOTHING
         RETURNING consumed_at`,
        [tenant, digest, expiresAt]
      );
    } catch {
      throw new IntegrationReplayError('INTEGRATION_REPLAY_GUARD_UNAVAILABLE', 503);
    }

    if (!result || result.rowCount !== 1 || result.rows.length !== 1) {
      throw new IntegrationReplayError('INTEGRATION_TOKEN_REPLAY', 401);
    }
    return true;
  }

  return Object.freeze({ consume });
}

module.exports = { createIntegrationReplayGuard, IntegrationReplayError };
