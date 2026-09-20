'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const ENCRYPTION_KEY = 'cd'.repeat(32); // Synthetic test fixture; not a deployment key.
const PASSWORD = 'synthetic-strong-password-2026';
const invalidCredentials = error => error instanceof StaffAuthError &&
  error.code === 'INVALID_CREDENTIALS' && error.statusCode === 401;

function decodeBase32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let accumulator = 0;
  let bits = 0;
  const result = [];
  for (const character of text) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return Buffer.from(result);
}

test('MFA login configuration cannot silently downgrade to password-only', async () => {
  const fake = { connect() { throw new Error('Unexpected DB access'); }, query() { throw new Error('Unexpected DB access'); } };
  assert.throws(() => createStaffAuthStore({ pool: fake, businessId: 'synthetic', totpStore: {} }), TypeError);
  const legacy = createStaffAuthStore({ pool: fake, businessId: 'synthetic' });
  await assert.rejects(legacy.authenticateWithTotp({ email: 'owner@example.test', password: PASSWORD, code: '123456' }),
    error => error instanceof StaffAuthError && error.code === 'MFA_NOT_CONFIGURED');
  const protectedStore = createStaffAuthStore({ pool: fake, businessId: 'synthetic', totpStore: { verify() {} } });
  await assert.rejects(protectedStore.authenticate({ email: 'owner@example.test', password: PASSWORD }),
    error => error instanceof StaffAuthError && error.code === 'MFA_REQUIRED');
});

test('disposable PostgreSQL: no session before password plus one-time TOTP, even in concurrent requests',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 10 });
    const businessId = `mfa-login-${crypto.randomUUID()}`;
    const foreignId = `mfa-foreign-${crypto.randomUUID()}`;
    const email = `owner-${crypto.randomUUID()}@example.test`;
    let timestamp = 59000;
    const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex: ENCRYPTION_KEY,
      now: () => timestamp });
    const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
    const foreignTotp = createStaffTotpStore({ pool, businessId: foreignId, encryptionKeyHex: ENCRYPTION_KEY,
      now: () => timestamp });
    const foreign = createStaffAuthStore({ pool, businessId: foreignId, totpStore: foreignTotp });
    const countSessions = async () => {
      const result = await pool.query('SELECT count(*)::integer AS total FROM facturations_staff_sessions WHERE business_id=$1',
        [businessId]);
      return result.rows[0].total;
    };
    try {
      const member = await auth.createPendingStaff({ email, password: PASSWORD, role: 'OWNER' });
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: '123456' }), invalidCredentials);
      assert.equal(await countSessions(), 0);
      await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
        [businessId, member.id]);
      const { secretBase32 } = await totp.provisionTrusted(member.id);
      const secret = decodeBase32(secretBase32);
      assert.equal(secret.length, 20);
      assert.equal(await totp.confirmTrusted(member.id, oneTimeCode(secret, 1)), true);
      timestamp = 89000; // Next TOTP step; provisioning code is already consumed.
      const current = oneTimeCode(secret, 2);
      const wrong = current === '000000' ? '111111' : '000000';
      await assert.rejects(auth.authenticate({ email, password: PASSWORD }),
        error => error instanceof StaffAuthError && error.code === 'MFA_REQUIRED');
      await assert.rejects(auth.authenticateWithTotp({ email, password: 'incorrect-password-2026', code: current }),
        invalidCredentials);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: wrong }), invalidCredentials);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: 'invalid' }), invalidCredentials);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: oneTimeCode(secret, 1) }),
        invalidCredentials);
      await assert.rejects(foreign.authenticateWithTotp({ email, password: PASSWORD, code: current }),
        invalidCredentials);
      assert.equal(await countSessions(), 0);
      const first = await auth.authenticateWithTotp({ email, password: PASSWORD, code: current });
      assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(first.staff.businessId, businessId);
      assert.deepEqual(await auth.getSession(first.token), first.staff);
      assert.equal(await foreign.getSession(first.token), null);
      assert.equal(await countSessions(), 1);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: current }), invalidCredentials);
      assert.equal(await countSessions(), 1);
      timestamp = 149000; // Two app instances race to redeem same 30-second code.
      const next = oneTimeCode(secret, 4);
      const otherInstance = createStaffAuthStore({ pool, businessId,
        totpStore: createStaffTotpStore({ pool, businessId, encryptionKeyHex: ENCRYPTION_KEY,
          now: () => timestamp }) });
      const attempts = await Promise.allSettled([
        auth.authenticateWithTotp({ email, password: PASSWORD, code: next }),
        otherInstance.authenticateWithTotp({ email, password: PASSWORD, code: next }),
      ]);
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter(result => result.status === 'rejected' && invalidCredentials(result.reason)).length, 1);
      assert.equal(await countSessions(), 2);
      await pool.query('UPDATE facturations_staff_users SET enabled=false WHERE business_id=$1 AND id=$2',
        [businessId, member.id]);
      timestamp = 179000;
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: oneTimeCode(secret, 5) }),
        invalidCredentials);
      assert.equal(await countSessions(), 2);
    } finally {
      await pool.end();
    }
  });
