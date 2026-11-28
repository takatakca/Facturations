'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');
const {
  FirstOwnerBootstrapError,
  bootstrapFirstOwner,
  confirmFirstOwnerTotp,
  rotatePendingFirstOwnerTotp,
  otpauthUri,
} = require('../src/first-owner-bootstrap');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const KEY = 'ad'.repeat(32); // Fictional fixture only; never a deployment key.
const code = expected => error => error instanceof FirstOwnerBootstrapError && error.code === expected;

function fromBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let accumulator = 0;
  let bits = 0;
  const bytes = [];
  for (const character of value) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

test('otpauth URI is standard and escapes the label', () => {
  assert.equal(otpauthUri('owner@example.test', 'ABC234'),
    'otpauth://totp/GROUPE%20TAKATAK%20Facturations%3Aowner%40example.test?secret=ABC234' +
    '&issuer=GROUPE%20TAKATAK%20Facturations&algorithm=SHA1&digits=6&period=30');
});

test('first OWNER ceremony on disposable PostgreSQL', { skip: !DATABASE }, async () => {
  const url = new URL(DATABASE);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE, max: 6 });
  const businessId = `bootstrap-test-${crypto.randomUUID()}`;
  const email = `owner-${crypto.randomUUID()}@example.test`;
  let timestamp = 59000; // TOTP step 1
  const now = () => timestamp;
  const context = { pool, businessId, encryptionKeyHex: KEY, now };
  try {
    await assert.rejects(bootstrapFirstOwner({ ...context, email, confirmation: 'yes',
      verificationReference: 'owner present' }), code('CONFIRMATION_REQUIRED'));
    await assert.rejects(bootstrapFirstOwner({ ...context, email, confirmation: 'BOOTSTRAP_FIRST_OWNER',
      verificationReference: '' }), code('VERIFICATION_REFERENCE_REQUIRED'));

    const created = await bootstrapFirstOwner({ ...context, email, confirmation: 'BOOTSTRAP_FIRST_OWNER',
      verificationReference: 'owner present at console (synthetic test)' });
    assert.match(created.password, /^[A-Za-z0-9_-]{32}$/);
    assert.match(created.totpSecret, /^[A-Z2-7]{32}$/);
    const row = await pool.query(
      'SELECT role,email_verified_at IS NOT NULL AS verified FROM facturations_staff_users WHERE business_id=$1',
      [businessId]);
    assert.deepEqual(row.rows, [{ role: 'OWNER', verified: true }]);

    // A second bootstrap for the same business is always refused.
    await assert.rejects(bootstrapFirstOwner({ ...context, email: `x-${email}`, confirmation: 'BOOTSTRAP_FIRST_OWNER',
      verificationReference: 'second attempt' }), code('STAFF_ALREADY_EXISTS'));

    const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex: KEY, now });
    const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
    const firstSecret = fromBase32(created.totpSecret);
    // No login is possible before TOTP activation.
    await assert.rejects(auth.authenticateWithTotp({ email, password: created.password,
      code: oneTimeCode(firstSecret, 1) }), StaffAuthError);

    // Lost key during setup: rotate the pending secret; the old one stops working.
    const rotated = await rotatePendingFirstOwnerTotp({ ...context, email });
    assert.notEqual(rotated.totpSecret, created.totpSecret);
    await assert.rejects(confirmFirstOwnerTotp({ ...context, email, code: oneTimeCode(firstSecret, 1) }),
      code('TOTP_CODE_INVALID'));
    const secret = fromBase32(rotated.totpSecret);
    await assert.rejects(confirmFirstOwnerTotp({ ...context, email: `other-${email}`, code: oneTimeCode(secret, 1) }),
      code('FIRST_OWNER_NOT_FOUND'));
    const confirmed = await confirmFirstOwnerTotp({ ...context, email, code: oneTimeCode(secret, 1) });
    assert.equal(confirmed.totpActive, true);

    // Once active, the bootstrap commands can no longer touch the secret.
    await assert.rejects(rotatePendingFirstOwnerTotp({ ...context, email }), code('TOTP_ALREADY_ACTIVE'));
    await assert.rejects(confirmFirstOwnerTotp({ ...context, email, code: oneTimeCode(secret, 1) }),
      code('TOTP_ALREADY_ACTIVE'));

    // Real MFA login works with the next code.
    timestamp = 89000; // step 2
    const session = await auth.authenticateWithTotp({ email, password: created.password,
      code: oneTimeCode(secret, 2) });
    assert.ok(session && session.token);
  } finally {
    await pool.end();
  }
});
