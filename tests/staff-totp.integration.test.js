'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const ENCRYPTION_KEY = 'ab'.repeat(32); // Synthetic test-only key; never use for real accounts.
const PASSWORD = 'fictional-strong-password-2026';

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

// Independent implementation in the test avoids relying on the application's generator.
function expectedCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = digest[19] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, '0');
}

test('RFC 6238 SHA-1 known vector and backend-only input validation', async () => {
  assert.equal(oneTimeCode(Buffer.from('12345678901234567890', 'ascii'), 1), '287082');
  assert.throws(() => oneTimeCode(Buffer.alloc(20), -1), TypeError);
  assert.throws(() => createStaffTotpStore({ pool: { query() {} }, businessId: 'test', encryptionKeyHex: 'not-a-key' }), TypeError);
  assert.throws(() => createStaffTotpStore({ pool: { query() {} }, businessId: '', encryptionKeyHex: ENCRYPTION_KEY }), TypeError);
  const store = createStaffTotpStore({ pool: { query() { throw new Error('Unexpected query'); } },
    businessId: 'test', encryptionKeyHex: ENCRYPTION_KEY });
  await assert.rejects(store.provisionTrusted('invalid-id'), TypeError);
  await assert.rejects(store.verify('invalid-id', '123456'), TypeError);
  assert.equal(await store.verify('11111111-1111-4111-8111-111111111111', 'not-otp'), false);
});

test('disposable PostgreSQL: encrypted TOTP activation, strict business scope, one-time codes and failures',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 10 });
    const tenant = `mfa-test-${crypto.randomUUID()}`;
    const otherTenant = `mfa-other-${crypto.randomUUID()}`;
    let timestamp = 59000;
    const first = createStaffTotpStore({ pool, businessId: tenant,
      encryptionKeyHex: ENCRYPTION_KEY, now: () => timestamp });
    const second = createStaffTotpStore({ pool, businessId: tenant,
      encryptionKeyHex: ENCRYPTION_KEY, now: () => timestamp });
    const foreign = createStaffTotpStore({ pool, businessId: otherTenant,
      encryptionKeyHex: ENCRYPTION_KEY, now: () => timestamp });
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    try {
      const member = await auth.createPendingStaff({ email: `mfa-${crypto.randomUUID()}@example.test`,
        password: PASSWORD, role: 'OWNER' });
      await assert.rejects(first.provisionTrusted(member.id), /unavailable/);
      await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
        [tenant, member.id]);
      const { secretBase32 } = await first.provisionTrusted(member.id);
      assert.match(secretBase32, /^[A-Z2-7]{32}$/);
      assert.equal(fromBase32(secretBase32).length, 20);
      await assert.rejects(first.provisionTrusted(member.id), /unavailable/);
      await assert.rejects(foreign.provisionTrusted(member.id), /unavailable/);
      const stored = await pool.query(
        'SELECT secret_iv,secret_ciphertext,secret_tag,active,last_used_step FROM facturations_staff_totp WHERE business_id=$1 AND user_id=$2',
        [tenant, member.id]);
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].active, false);
      assert.equal(stored.rows[0].last_used_step, null);
      assert.equal(stored.rows[0].secret_iv.length, 12);
      assert.equal(stored.rows[0].secret_tag.length, 16);
      assert.equal(stored.rows[0].secret_ciphertext.length, 20);
      assert.notDeepEqual(stored.rows[0].secret_ciphertext, fromBase32(secretBase32));

      const secret = fromBase32(secretBase32);
      const current = expectedCode(secret, 1);
      assert.equal(await first.verify(member.id, current), false); // Not activated.
      assert.equal(await first.confirmTrusted(member.id, '000000' === current ? '999999' : '000000'), false);
      assert.equal(await foreign.confirmTrusted(member.id, current), false);
      assert.equal(await first.confirmTrusted(member.id, current), true);
      assert.equal(await first.confirmTrusted(member.id, current), false);
      assert.equal(await first.verify(member.id, current), false); // Enrollment step cannot be replayed.
      timestamp = 89000;
      const nextCode = expectedCode(secret, 2);
      assert.equal(await first.verify(member.id, nextCode), true);
      assert.equal(await first.verify(member.id, nextCode), false);
      assert.equal(await foreign.verify(member.id, nextCode), false);

      timestamp = 149000; // Step 4, two independent backend instances race to use one code.
      const concurrent = expectedCode(secret, 4);
      const results = await Promise.all([first.verify(member.id, concurrent), second.verify(member.id, concurrent)]);
      assert.deepEqual(results.sort(), [false, true]);
      assert.equal(await first.verify(member.id, expectedCode(secret, 3)), false);
      await pool.query('UPDATE facturations_staff_users SET enabled=false WHERE business_id=$1 AND id=$2',
        [tenant, member.id]);
      timestamp = 179000;
      assert.equal(await first.verify(member.id, expectedCode(secret, 5)), false);
      await pool.query('UPDATE facturations_staff_users SET enabled=true WHERE business_id=$1 AND id=$2',
        [tenant, member.id]);
      await pool.query("UPDATE facturations_staff_totp SET secret_tag=decode(repeat('00',16),'hex') WHERE business_id=$1 AND user_id=$2",
        [tenant, member.id]);
      await assert.rejects(first.verify(member.id, expectedCode(secret, 5)));
    } finally {
      await pool.end();
    }
  });
