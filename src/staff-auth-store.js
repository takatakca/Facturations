'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOTP_PATTERN = /^[0-9]{6}$/;

class StaffAuthError extends Error {
  constructor(code, statusCode = 401) {
    super(code);
    this.name = 'StaffAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string') throw new StaffAuthError('INVALID_EMAIL', 422);
  const value = email.trim().toLowerCase();
  if (value.length > 254 || value.length < 3 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/u.test(value) ||
      value.includes('..') || value.startsWith('.') || value.includes('@.') || value.includes('.@')) {
    throw new StaffAuthError('INVALID_EMAIL', 422);
  }
  return value;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(password)) {
    throw new StaffAuthError('INVALID_PASSWORD', 422);
  }
}

async function derive(password, salt) {
  return scrypt(password, salt, 64, SCRYPT_OPTIONS);
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function createStaffAuthStore({ pool, businessId, totpStore = null }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || businessId.trim().length < 1 || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  if (totpStore !== null && (typeof totpStore !== 'object' || typeof totpStore.verify !== 'function')) {
    throw new TypeError('A valid tenant-scoped TOTP store is required');
  }
  const tenant = businessId.trim();

  // Trusted provisioning code ONLY. Never expose this method as a public HTTP endpoint.
  // Accounts start unverified and cannot authenticate until a separate, audited email-verification flow exists.
  async function createPendingStaff({ email, password, role = 'STAFF' }) {
    const normalized = normalizeEmail(email);
    checkPassword(password);
    if (!['OWNER', 'STAFF'].includes(role)) throw new StaffAuthError('INVALID_ROLE', 422);
    const salt = crypto.randomBytes(16);
    const passwordHash = await derive(password, salt);
    try {
      const result = await pool.query(
        'INSERT INTO facturations_staff_users (business_id,email_normalized,role,password_salt,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, email_normalized, role, created_at',
        [tenant, normalized, role, salt, passwordHash]
      );
      return { id: result.rows[0].id, email: result.rows[0].email_normalized,
        role: result.rows[0].role, emailVerified: false, createdAt: result.rows[0].created_at };
    } catch (error) {
      if (error.code === '23505') throw new StaffAuthError('STAFF_ALREADY_EXISTS', 409);
      throw error;
    }
  }

  // Legacy trusted/backend-only password authentication for isolated tests.
  // If MFA is configured, it cannot issue sessions: use authenticateWithTotp instead.
  // Neither method is exposed to HTTP; browser login additionally needs durable rate
  // limiting, verified enrollment, HTTPS, Origin/CSRF and a secure cookie response.
  async function authenticate({ email, password }) {
    if (totpStore) throw new StaffAuthError('MFA_REQUIRED', 403);
    return authenticateCredentials({ email, password }, false);
  }

  async function authenticateWithTotp({ email, password, code }) {
    if (!totpStore) throw new StaffAuthError('MFA_NOT_CONFIGURED', 503);
    return authenticateCredentials({ email, password, code }, true);
  }

  async function authenticateCredentials({ email, password, code }, requireTotp) {
    let normalized;
    try { normalized = normalizeEmail(email); }
    catch { throw new StaffAuthError('INVALID_CREDENTIALS'); }
    if (typeof password !== 'string' || password.length > 1024 || password.length === 0) {
      throw new StaffAuthError('INVALID_CREDENTIALS');
    }
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const found = await client.query(
        `SELECT id,email_normalized,role,password_salt,password_hash,email_verified_at,enabled,failed_attempts,
                (locked_until > now()) AS is_locked, locked_until
           FROM facturations_staff_users WHERE business_id=$1 AND email_normalized=$2 FOR UPDATE`,
        [tenant, normalized]
      );
      const user = found.rows[0];
      // Perform comparable password-hashing work even when the user does not exist.
      const candidate = await derive(password, user ? user.password_salt : Buffer.alloc(16));
      const expected = user ? user.password_hash : Buffer.alloc(64);
      const matches = crypto.timingSafeEqual(candidate, expected);
      if (!user || !user.enabled || !user.email_verified_at || user.is_locked || !matches) {
        if (user && user.enabled && user.email_verified_at && !user.is_locked && !matches) {
          const failures = user.locked_until ? 1 : Math.min(5, user.failed_attempts + 1);
          await client.query(
            `UPDATE facturations_staff_users SET failed_attempts=$3,
                    locked_until=CASE WHEN $3 >= 5 THEN now()+interval '15 minutes' ELSE NULL END
              WHERE business_id=$1 AND id=$2`,
            [tenant, user.id, failures]
          );
        }
        await client.query('COMMIT');
        transaction = false;
        throw new StaffAuthError('INVALID_CREDENTIALS');
      }
      // The one-time code must be verified and consumed BEFORE any session row is inserted.
      // A caller-controlled value can never disable this check when MFA is configured.
      if (requireTotp && (!TOTP_PATTERN.test(code) || !(await totpStore.verify(user.id, code)))) {
        throw new StaffAuthError('INVALID_CREDENTIALS');
      }
      await client.query(
        'UPDATE facturations_staff_users SET failed_attempts=0, locked_until=NULL WHERE business_id=$1 AND id=$2',
        [tenant, user.id]
      );
      const token = crypto.randomBytes(32).toString('base64url');
      const inserted = await client.query(
        `INSERT INTO facturations_staff_sessions (business_id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,now()+interval '12 hours') RETURNING expires_at`,
        [tenant, user.id, tokenDigest(token)]
      );
      await client.query('COMMIT');
      transaction = false;
      return { token, expiresAt: inserted.rows[0].expires_at,
        staff: { id: user.id, email: user.email_normalized, role: user.role, businessId: tenant } };
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getSession(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const result = await pool.query(
      `SELECT u.id, u.email_normalized, u.role
         FROM facturations_staff_sessions s
         JOIN facturations_staff_users u ON u.business_id=s.business_id AND u.id=s.user_id
        WHERE s.business_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND u.enabled AND u.email_verified_at IS NOT NULL`,
      [tenant, tokenDigest(token)]
    );
    if (!result.rows.length) return null;
    return { id: result.rows[0].id, email: result.rows[0].email_normalized,
      role: result.rows[0].role, businessId: tenant };
  }

  async function revokeSession(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const result = await pool.query(
      `UPDATE facturations_staff_sessions SET revoked_at=now()
        WHERE business_id=$1 AND token_hash=$2 AND revoked_at IS NULL RETURNING id`,
      [tenant, tokenDigest(token)]
    );
    return result.rows.length === 1;
  }

  // Trusted backend-only operation for future security response and staff disablement.
  // Never expose this directly as a public endpoint or accept a business ID from the caller.
  async function revokeAllSessionsForStaff(staffId) {
    if (typeof staffId !== 'string' || !UUID_PATTERN.test(staffId)) {
      throw new StaffAuthError('INVALID_STAFF_ID', 422);
    }
    const result = await pool.query(
      `UPDATE facturations_staff_sessions SET revoked_at=now()
        WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [tenant, staffId]
    );
    return result.rows.length;
  }

  return Object.freeze({ createPendingStaff, authenticate, authenticateWithTotp,
    getSession, revokeSession, revokeAllSessionsForStaff });
}

module.exports = { createStaffAuthStore, StaffAuthError, normalizeEmail };
