'use strict';

const crypto = require('node:crypto');
const { normalizeEmail } = require('./staff-auth-store');

// Shared across app processes through the dedicated PostgreSQL database.
// Backend-only: the browser login must call reserve BEFORE password hashing,
// reset ONLY after a verified successful login, and fail closed on DB errors.
// An independent trusted-edge per-IP limit is still required before deployment.
function createLoginAttemptLimit({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Dedicated PostgreSQL pool required');
  if (typeof businessId !== 'string' || businessId.trim().length < 1 || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();
  function digest(email) {
    return crypto.createHash('sha256').update(normalizeEmail(email), 'utf8').digest();
  }

  async function reserve(email) {
    const identityHash = digest(email);
    const result = await pool.query(
      `INSERT INTO facturations_login_attempt_limits AS limits
         (business_id, identity_hash, window_started_at, attempts, blocked_until)
       VALUES ($1, $2, now(), 1, NULL)
       ON CONFLICT (business_id, identity_hash) DO UPDATE SET
         attempts = CASE
           WHEN limits.blocked_until > now() THEN limits.attempts
           WHEN limits.window_started_at <= now() - interval '15 minutes' THEN 1
           ELSE LEAST(limits.attempts + 1, 10) END,
         window_started_at = CASE
           WHEN limits.blocked_until > now() THEN limits.window_started_at
           WHEN limits.window_started_at <= now() - interval '15 minutes' THEN now()
           ELSE limits.window_started_at END,
         blocked_until = CASE
           WHEN limits.blocked_until > now() THEN limits.blocked_until
           WHEN limits.window_started_at <= now() - interval '15 minutes' THEN NULL
           WHEN limits.attempts >= 9 THEN now() + interval '15 minutes'
           ELSE NULL END
       RETURNING blocked_until > now() AS blocked`,
      [tenant, identityHash]
    );
    if (result.rows.length !== 1 || typeof result.rows[0].blocked !== 'boolean') {
      throw new Error('Login attempt limit unavailable');
    }
    return !result.rows[0].blocked;
  }

  async function reset(email) {
    const result = await pool.query(
      'DELETE FROM facturations_login_attempt_limits WHERE business_id=$1 AND identity_hash=$2',
      [tenant, digest(email)]
    );
    return result.rowCount > 0;
  }

  return Object.freeze({ reserve, reset });
}

module.exports = { createLoginAttemptLimit };
