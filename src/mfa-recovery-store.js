'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONFIRMATION = 'AUTHORIZE_OWNER_MFA_RECOVERY';
const METHOD = 'HUMAN_OUT_OF_BAND';

class MfaRecoveryError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'MfaRecoveryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function staffId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new MfaRecoveryError('INVALID_STAFF_ID');
  }
  return value.toLowerCase();
}

function reference(value) {
  if (typeof value !== 'string') throw new MfaRecoveryError('INVALID_VERIFICATION_REFERENCE');
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MfaRecoveryError('INVALID_VERIFICATION_REFERENCE');
  }
  return normalized;
}

function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MfaRecoveryError('INVALID_RECOVERY_CREDENTIALS', 401);
  }
  return value;
}

async function derive(password, salt) {
  return scrypt(password, salt, 64, SCRYPT_OPTIONS);
}

function createMfaRecoveryStore({ pool, businessId, totpStore }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  if (!totpStore || typeof totpStore.rotateTrusted !== 'function') {
    throw new TypeError('Trusted TOTP rotation store required');
  }
  const tenant = businessId.trim();

  async function issueTrusted(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'confirmation,staffId,verificationMethod,verificationReference') {
      throw new MfaRecoveryError('INVALID_RECOVERY_ISSUE_REQUEST');
    }
    if (input.confirmation !== CONFIRMATION) {
      throw new MfaRecoveryError('RECOVERY_CONFIRMATION_REQUIRED');
    }
    if (input.verificationMethod !== METHOD) {
      throw new MfaRecoveryError('INVALID_VERIFICATION_METHOD');
    }

    const id = staffId(input.staffId);
    const verificationReference = reference(input.verificationReference);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const user = await client.query(
        `SELECT id,role,enabled,email_verified_at
           FROM facturations_staff_users
          WHERE business_id=$1 AND id=$2
          FOR UPDATE`,
        [tenant, id]
      );
      const owner = user.rows[0];
      if (!owner || !owner.enabled || !owner.email_verified_at || owner.role !== 'OWNER') {
        throw new MfaRecoveryError('RECOVERABLE_OWNER_NOT_FOUND', 404);
      }

      const prior = await client.query(
        `SELECT a.id
           FROM facturations_mfa_recovery_authorizations a
          WHERE a.business_id=$1 AND a.user_id=$2 AND a.expires_at > now()
            AND NOT EXISTS (
              SELECT 1 FROM facturations_mfa_recovery_events e
               WHERE e.business_id=a.business_id AND e.authorization_id=a.id
                 AND e.event_type IN ('CONSUMED','REVOKED')
            )
          ORDER BY a.issued_at
          FOR UPDATE OF a`,
        [tenant, id]
      );
      for (const row of prior.rows) {
        await client.query(
          `INSERT INTO facturations_mfa_recovery_events
             (business_id,authorization_id,event_type,reason_code)
           VALUES ($1,$2,'REVOKED','SUPERSEDED_BY_NEW_RECOVERY')`,
          [tenant, row.id]
        );
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const authorization = await client.query(
        `INSERT INTO facturations_mfa_recovery_authorizations
           (business_id,user_id,token_hash,verification_method,verification_reference,
            confirmation,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')
         RETURNING id,expires_at`,
        [tenant, id, digest(token), METHOD, verificationReference, CONFIRMATION]
      );
      await client.query(
        `INSERT INTO facturations_mfa_recovery_events
           (business_id,authorization_id,event_type,reason_code)
         VALUES ($1,$2,'ISSUED','HUMAN_IDENTITY_VERIFIED')`,
        [tenant, authorization.rows[0].id]
      );

      await client.query('COMMIT');
      transaction = false;
      return Object.freeze({
        authorizationId: authorization.rows[0].id,
        staffId: id,
        token,
        expiresAt: authorization.rows[0].expires_at,
      });
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function redeem(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'password,token') {
      throw new MfaRecoveryError('INVALID_RECOVERY_REDEEM_REQUEST');
    }
    if (typeof input.token !== 'string' || !TOKEN.test(input.token)) {
      throw new MfaRecoveryError('INVALID_RECOVERY_CREDENTIALS', 401);
    }
    const password = passwordValue(input.password);
    const tokenHash = digest(input.token);

    const lookup = await pool.query(
      `SELECT id,user_id
         FROM facturations_mfa_recovery_authorizations
        WHERE business_id=$1 AND token_hash=$2`,
      [tenant, tokenHash]
    );
    if (!lookup.rows.length) {
      throw new MfaRecoveryError('INVALID_RECOVERY_CREDENTIALS', 401);
    }

    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const users = await client.query(
        `SELECT id,email_normalized,role,enabled,email_verified_at,password_salt,password_hash
           FROM facturations_staff_users
          WHERE business_id=$1 AND id=$2
          FOR UPDATE`,
        [tenant, lookup.rows[0].user_id]
      );
      const user = users.rows[0];

      const authorizations = await client.query(
        `SELECT id,user_id,expires_at > now() AS unexpired
           FROM facturations_mfa_recovery_authorizations
          WHERE business_id=$1 AND id=$2 AND token_hash=$3
          FOR UPDATE`,
        [tenant, lookup.rows[0].id, tokenHash]
      );
      const authorization = authorizations.rows[0];

      const terminal = authorization
        ? await client.query(
          `SELECT event_type
             FROM facturations_mfa_recovery_events
            WHERE business_id=$1 AND authorization_id=$2
              AND event_type IN ('CONSUMED','REVOKED')
            LIMIT 1`,
          [tenant, authorization.id]
        )
        : { rows: [] };

      if (!user || !authorization || !authorization.unexpired ||
          terminal.rows.length || !user.enabled || !user.email_verified_at ||
          user.role !== 'OWNER') {
        throw new MfaRecoveryError('INVALID_RECOVERY_CREDENTIALS', 401);
      }

      const candidate = await derive(password, user.password_salt);
      const passwordMatches = crypto.timingSafeEqual(candidate, user.password_hash);
      candidate.fill(0);
      if (!passwordMatches) {
        throw new MfaRecoveryError('INVALID_RECOVERY_CREDENTIALS', 401);
      }

      const rotated = await totpStore.rotateTrusted(user.id, client);

      await client.query(
        `UPDATE facturations_staff_sessions
            SET revoked_at=now()
          WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [tenant, user.id]
      );

      await client.query(
        `INSERT INTO facturations_mfa_recovery_events
           (business_id,authorization_id,event_type,reason_code)
         VALUES ($1,$2,'CONSUMED','TOTP_ROTATED_SESSIONS_REVOKED')`,
        [tenant, authorization.id]
      );

      await client.query('COMMIT');
      transaction = false;
      return Object.freeze({
        authorizationId: authorization.id,
        staffId: user.id,
        secretBase32: rotated.secretBase32,
        mustActivate: true,
      });
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ issueTrusted, redeem });
}

module.exports = { createMfaRecoveryStore, MfaRecoveryError };
