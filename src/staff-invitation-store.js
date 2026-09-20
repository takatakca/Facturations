'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { StaffAuthError } = require('./staff-auth-store');
const scrypt = promisify(crypto.scrypt);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(password)) {
    throw new StaffAuthError('INVALID_PASSWORD', 422);
  }
}

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function createStaffInvitationStore({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  // TRUSTED provisioning only: never expose invitation issuance through an unauthenticated endpoint.
  // Delivery to the verified, intended mailbox is a separate, currently unimplemented requirement.
  async function issueInvitation({ staffId }) {
    if (typeof staffId !== 'string' || !UUID_PATTERN.test(staffId)) {
      throw new StaffAuthError('INVALID_STAFF_ID', 422);
    }
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const found = await client.query(
        `SELECT id,enabled,email_verified_at FROM facturations_staff_users
          WHERE business_id=$1 AND id=$2 FOR UPDATE`,
        [tenant, staffId]
      );
      const staff = found.rows[0];
      if (!staff) throw new StaffAuthError('STAFF_NOT_FOUND', 404);
      if (!staff.enabled || staff.email_verified_at) throw new StaffAuthError('STAFF_NOT_PENDING', 409);

      // Holding the staff row lock serializes invitation reissues for that member.
      await client.query(
        `UPDATE facturations_staff_invitations SET revoked_at=now()
          WHERE business_id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [tenant, staffId]
      );
      const token = crypto.randomBytes(32).toString('base64url');
      const saved = await client.query(
        `INSERT INTO facturations_staff_invitations (business_id,user_id,token_hash,expires_at)
          VALUES ($1,$2,$3,now()+interval '24 hours') RETURNING expires_at`,
        [tenant, staffId, digest(token)]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return { token, expiresAt: saved.rows[0].expires_at };
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Redeem only AFTER securely delivering the one-time token to the intended mailbox.
  // No HTTP endpoint is exposed: rate limiting, CSRF, MFA and an audited delivery flow remain necessary.
  async function redeemInvitation({ token, password }) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new StaffAuthError('INVALID_INVITATION');
    }
    checkNewPassword(password);
    const tokenHash = digest(token);
    // Resolve staff ID without locking; lock the STAFF row first in both issuance and redemption.
    // Recheck invitation state under lock to prevent reissue/redeem races and deadlocks.
    const lookup = await pool.query(
      `SELECT user_id FROM facturations_staff_invitations WHERE business_id=$1 AND token_hash=$2`,
      [tenant, tokenHash]
    );
    if (!lookup.rows.length) throw new StaffAuthError('INVALID_INVITATION');

    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const users = await client.query(
        `SELECT id,email_normalized,role,enabled,email_verified_at
           FROM facturations_staff_users WHERE business_id=$1 AND id=$2 FOR UPDATE`,
        [tenant, lookup.rows[0].user_id]
      );
      const invitations = await client.query(
        `SELECT id,consumed_at,revoked_at,(expires_at > now()) AS valid_until
           FROM facturations_staff_invitations
          WHERE business_id=$1 AND user_id=$2 AND token_hash=$3 FOR UPDATE`,
        [tenant, lookup.rows[0].user_id, tokenHash]
      );
      const user = users.rows[0];
      const invitation = invitations.rows[0];
      if (!user || !user.enabled || user.email_verified_at || !invitation ||
          invitation.consumed_at || invitation.revoked_at || !invitation.valid_until) {
        throw new StaffAuthError('INVALID_INVITATION');
      }
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
      await client.query(
        `UPDATE facturations_staff_users SET password_salt=$3,password_hash=$4,email_verified_at=now(),
                failed_attempts=0,locked_until=NULL
          WHERE business_id=$1 AND id=$2`,
        [tenant, user.id, salt, passwordHash]
      );
      await client.query(
        `UPDATE facturations_staff_invitations SET consumed_at=now()
          WHERE business_id=$1 AND id=$2`,
        [tenant, invitation.id]
      );
      // Do not leave previously issued sessions active after a credential reset/activation.
      await client.query(
        `UPDATE facturations_staff_sessions SET revoked_at=now()
          WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [tenant, user.id]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return { id: user.id, email: user.email_normalized, role: user.role, businessId: tenant, emailVerified: true };
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ issueInvitation, redeemInvitation });
}

module.exports = { createStaffInvitationStore };
