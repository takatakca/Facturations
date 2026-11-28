'use strict';

// Trusted, OFFLINE first-OWNER enrollment ceremony for a brand-new dedicated
// Facturations database. Never wired to HTTP. Runs only from the server
// console by the operator, with the owner physically present.
//
// - Only allowed while the business has NO staff account at all.
// - Email ownership is attested out of band by the operator (the owner is the
//   operator); a non-secret reference of that verification is required.
// - TOTP is mandatory: the account cannot log in until the owner confirms a
//   code from an authenticator app. Until then, the pending secret may be
//   rotated (lost phone during setup) without any other effect.

const crypto = require('node:crypto');
const { createStaffAuthStore } = require('./staff-auth-store');
const { createStaffTotpStore } = require('./staff-totp-store');

const CONFIRMATION = 'BOOTSTRAP_FIRST_OWNER';
const ADVISORY_LOCK_KEY = 7_204_311_046;
const ISSUER = 'GROUPE TAKATAK Facturations';

class FirstOwnerBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FirstOwnerBootstrapError';
    this.code = code;
  }
}

function generatePassword() {
  // 24 random bytes -> 32 base64url characters (192 bits).
  return crypto.randomBytes(24).toString('base64url');
}

function otpauthUri(email, secretBase32) {
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function verificationReferenceValue(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new FirstOwnerBootstrapError('VERIFICATION_REFERENCE_REQUIRED');
  }
  return value.trim();
}

function stores({ pool, businessId, encryptionKeyHex, now }) {
  const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex, ...(now ? { now } : {}) });
  const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
  return { totp, auth };
}

async function withLock(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    return await run(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * Step 1. Creates the single first OWNER (email marked verified by the
 * operator's out-of-band attestation) and a PENDING TOTP secret.
 * Returns the password (generated unless provided) and secret ONCE.
 */
async function bootstrapFirstOwner({
  pool, businessId, encryptionKeyHex, email, password = null, confirmation, verificationReference, now,
}) {
  if (confirmation !== CONFIRMATION) throw new FirstOwnerBootstrapError('CONFIRMATION_REQUIRED');
  const reference = verificationReferenceValue(verificationReference);
  const { totp, auth } = stores({ pool, businessId, encryptionKeyHex, now });
  const ownerPassword = password === null ? generatePassword() : password;

  return withLock(pool, async (client) => {
    const existing = await client.query(
      'SELECT count(*)::integer AS count FROM facturations_staff_users WHERE business_id=$1',
      [businessId]
    );
    if (existing.rows[0].count !== 0) throw new FirstOwnerBootstrapError('STAFF_ALREADY_EXISTS');

    const owner = await auth.createPendingStaff({ email, password: ownerPassword, role: 'OWNER' });
    const verified = await client.query(
      `UPDATE facturations_staff_users SET email_verified_at=now()
        WHERE business_id=$1 AND id=$2 AND role='OWNER' AND email_verified_at IS NULL
        RETURNING id`,
      [businessId, owner.id]
    );
    if (verified.rows.length !== 1) throw new FirstOwnerBootstrapError('OWNER_VERIFICATION_FAILED');
    const { secretBase32 } = await totp.provisionTrusted(owner.id);

    return Object.freeze({
      ownerId: owner.id,
      email: owner.email,
      password: password === null ? ownerPassword : null,
      totpSecret: secretBase32,
      otpauthUri: otpauthUri(owner.email, secretBase32),
      verificationReference: reference,
    });
  });
}

async function pendingOwner(client, businessId, email) {
  const found = await client.query(
    `SELECT u.id, u.email_normalized, t.active
       FROM facturations_staff_users u
       LEFT JOIN facturations_staff_totp t ON t.business_id=u.business_id AND t.user_id=u.id
      WHERE u.business_id=$1 AND u.role='OWNER' AND u.enabled
        AND u.email_normalized=lower(trim($2))`,
    [businessId, String(email || '')]
  );
  const staff = await client.query(
    'SELECT count(*)::integer AS count FROM facturations_staff_users WHERE business_id=$1',
    [businessId]
  );
  // The ceremony only applies to the very first account of the business.
  if (found.rows.length !== 1 || staff.rows[0].count !== 1) {
    throw new FirstOwnerBootstrapError('FIRST_OWNER_NOT_FOUND');
  }
  if (found.rows[0].active === true) throw new FirstOwnerBootstrapError('TOTP_ALREADY_ACTIVE');
  return found.rows[0];
}

/** Step 2. Activates TOTP with a code from the owner's authenticator app. */
async function confirmFirstOwnerTotp({ pool, businessId, encryptionKeyHex, email, code, now }) {
  const { totp } = stores({ pool, businessId, encryptionKeyHex, now });
  return withLock(pool, async (client) => {
    const owner = await pendingOwner(client, businessId, email);
    if (!(await totp.confirmTrusted(owner.id, String(code || '').trim()))) {
      throw new FirstOwnerBootstrapError('TOTP_CODE_INVALID');
    }
    return Object.freeze({ ownerId: owner.id, email: owner.email_normalized, totpActive: true });
  });
}

/**
 * Lost the pending secret before activation: discard the never-activated
 * secret and issue a new pending one. An activated secret is never touched
 * here (that is the separate MFA recovery ceremony).
 */
async function rotatePendingFirstOwnerTotp({ pool, businessId, encryptionKeyHex, email, now }) {
  const { totp } = stores({ pool, businessId, encryptionKeyHex, now });
  return withLock(pool, async (client) => {
    const owner = await pendingOwner(client, businessId, email);
    const removed = await client.query(
      `DELETE FROM facturations_staff_totp
        WHERE business_id=$1 AND user_id=$2 AND active=false
          AND activated_at IS NULL AND last_used_step IS NULL
        RETURNING user_id`,
      [businessId, owner.id]
    );
    if (removed.rows.length > 1) throw new FirstOwnerBootstrapError('TOTP_STATE_INVALID');
    const { secretBase32 } = await totp.provisionTrusted(owner.id);
    return Object.freeze({
      ownerId: owner.id,
      email: owner.email_normalized,
      totpSecret: secretBase32,
      otpauthUri: otpauthUri(owner.email_normalized, secretBase32),
    });
  });
}

module.exports = {
  CONFIRMATION,
  FirstOwnerBootstrapError,
  bootstrapFirstOwner,
  confirmFirstOwnerTotp,
  rotatePendingFirstOwnerTotp,
  otpauthUri,
};
