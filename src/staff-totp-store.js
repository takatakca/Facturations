'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^[0-9]{6}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function staffIdValue(staffId) {
  if (typeof staffId !== 'string' || !UUID.test(staffId)) throw new TypeError('Invalid staff ID');
  return staffId.toLowerCase();
}

function base32Encode(bytes) {
  let bits = 0;
  let accumulator = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += ALPHABET[(accumulator >>> bits) & 31];
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits) encoded += ALPHABET[(accumulator << (5 - bits)) & 31];
  return encoded;
}

function oneTimeCode(secret, step) {
  if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('Invalid TOTP step');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const truncated = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) | digest[offset + 3];
  return String(truncated % 1000000).padStart(6, '0');
}

// Backend-only TOTP. Provisioning must occur through a separately approved trusted
// enrollment ceremony with secure secret delivery, not a public API or an email log.
// The encryption key must be a separately stored random 32-byte server secret.
function createStaffTotpStore({ pool, businessId, encryptionKeyHex, now = Date.now }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Dedicated PostgreSQL pool required');
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  if (typeof encryptionKeyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) {
    throw new TypeError('A separate 256-bit TOTP encryption key is required');
  }
  if (typeof now !== 'function') throw new TypeError('Clock required');
  const tenant = businessId.trim();
  const key = Buffer.from(encryptionKeyHex, 'hex');

  function currentStep() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('TOTP clock unavailable');
    return Math.floor(timestamp / 30000);
  }

  function decrypt(row, id) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.secret_iv);
    decipher.setAAD(Buffer.from(`${tenant}\0${id}`, 'utf8'));
    decipher.setAuthTag(row.secret_tag);
    const secret = Buffer.concat([decipher.update(row.secret_ciphertext), decipher.final()]);
    if (secret.length !== 20) throw new Error('Invalid TOTP material');
    return secret;
  }

  function matchingStep(secret, code) {
    const step = currentStep();
    let matched = -1;
    for (const candidate of [step - 1, step, step + 1]) {
      if (candidate < 0) continue;
      const expected = Buffer.from(oneTimeCode(secret, candidate), 'ascii');
      const actual = Buffer.from(code, 'ascii');
      if (crypto.timingSafeEqual(expected, actual)) matched = candidate;
    }
    return matched;
  }

  async function provisionTrusted(staffId) {
    const id = staffIdValue(staffId);
    const secret = crypto.randomBytes(20);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${tenant}\0${id}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    const result = await pool.query(
      `INSERT INTO facturations_staff_totp
         (business_id,user_id,secret_iv,secret_ciphertext,secret_tag)
       SELECT u.business_id,u.id,$3,$4,$5 FROM facturations_staff_users u
        WHERE u.business_id=$1 AND u.id=$2 AND u.enabled AND u.email_verified_at IS NOT NULL
       ON CONFLICT (business_id,user_id) DO NOTHING RETURNING user_id`,
      [tenant, id, iv, encrypted, tag]
    );
    if (result.rows.length !== 1) throw new Error('TOTP provisioning unavailable');
    // The plaintext secret is returned ONCE; never persist it in logs, URLs or the repo.
    return { secretBase32: base32Encode(secret) };
  }

  // A login already holds a PostgreSQL transaction client and a staff row lock.
  // Use that SAME client for the TOTP read and atomic consume: borrowing another
  // connection from the pool can exhaust it and block every concurrent login.
  async function check(staffId, code, activating, queryClient = pool) {
    const id = staffIdValue(staffId);
    if (typeof code !== 'string' || !CODE.test(code)) return false;
    if (!queryClient || typeof queryClient.query !== 'function') {
      throw new TypeError('A PostgreSQL query client is required');
    }
    const found = await queryClient.query(
      `SELECT t.secret_iv,t.secret_ciphertext,t.secret_tag FROM facturations_staff_totp t
       JOIN facturations_staff_users u ON u.business_id=t.business_id AND u.id=t.user_id
       WHERE t.business_id=$1 AND t.user_id=$2 AND t.active=$3
         AND u.enabled AND u.email_verified_at IS NOT NULL`,
      [tenant, id, !activating]
    );
    if (found.rows.length !== 1) return false;
    const secret = decrypt(found.rows[0], id); // Authentication failure aborts closed.
    const step = matchingStep(secret, code);
    secret.fill(0);
    if (step < 0) return false;
    const update = activating
      ? `UPDATE facturations_staff_totp t SET active=true,activated_at=now(),last_used_step=$3
         WHERE t.business_id=$1 AND t.user_id=$2 AND t.active=false AND t.last_used_step IS NULL
           AND EXISTS (SELECT 1 FROM facturations_staff_users u WHERE u.business_id=t.business_id
                       AND u.id=t.user_id AND u.enabled AND u.email_verified_at IS NOT NULL)
         RETURNING t.user_id`
      : `UPDATE facturations_staff_totp t SET last_used_step=$3
         WHERE t.business_id=$1 AND t.user_id=$2 AND t.active=true
           AND t.last_used_step < $3
           AND EXISTS (SELECT 1 FROM facturations_staff_users u WHERE u.business_id=t.business_id
                       AND u.id=t.user_id AND u.enabled AND u.email_verified_at IS NOT NULL)
         RETURNING t.user_id`;
    const result = await queryClient.query(update, [tenant, id, step]);
    // Atomic update guarantees that simultaneous use of the same code succeeds once.
    return result.rows.length === 1;
  }

  return Object.freeze({
    provisionTrusted,
    confirmTrusted: (staffId, code) => check(staffId, code, true),
    verify: (staffId, code, transactionClient = pool) => check(staffId, code, false, transactionClient),
  });
}

module.exports = { createStaffTotpStore, oneTimeCode };
