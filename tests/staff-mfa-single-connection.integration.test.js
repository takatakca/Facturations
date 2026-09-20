'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const KEY = 'ac'.repeat(32); // Fictional fixture only; never a deployment key.
const PASSWORD = 'fictional-strong-password-2026';

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

const invalid = error => error instanceof StaffAuthError &&
  error.code === 'INVALID_CREDENTIALS' && error.statusCode === 401;

test('disposable PostgreSQL: MFA login succeeds with pool max=1, rejects replay and keeps sessions tenant-scoped',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    // Before the fix, auth holds the only connection and TOTP pool.query()
    // waits for another one until connectionTimeoutMillis expires.
    const pool = new Pool({ connectionString: DATABASE, max: 1, connectionTimeoutMillis: 750 });
    const businessId = `one-connection-${crypto.randomUUID()}`;
    const email = `staff-${crypto.randomUUID()}@example.test`;
    let clock = 59000;
    const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex: KEY, now: () => clock });
    const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
    const other = createStaffAuthStore({ pool, businessId: `foreign-${crypto.randomUUID()}` });
    try {
      const member = await auth.createPendingStaff({ email, password: PASSWORD, role: 'OWNER' });
      await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
        [businessId, member.id]);
      const { secretBase32 } = await totp.provisionTrusted(member.id);
      const secret = decodeBase32(secretBase32);
      assert.equal(await totp.confirmTrusted(member.id, oneTimeCode(secret, 1)), true);
      clock = 89000;
      const code = oneTimeCode(secret, 2);
      const wrong = code === '000000' ? '111111' : '000000';
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: wrong }), invalid);
      const session = await auth.authenticateWithTotp({ email, password: PASSWORD, code });
      assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(await auth.getSession(session.token), session.staff);
      assert.equal(await other.getSession(session.token), null);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code }), invalid);
      const count = await pool.query(
        'SELECT count(*)::integer AS total FROM facturations_staff_sessions WHERE business_id=$1', [businessId]);
      assert.equal(count.rows[0].total, 1);
    } finally {
      await pool.end();
    }
  });
