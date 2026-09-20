'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLoginAttemptLimit } = require('../src/login-attempt-limit');
const { StaffAuthError } = require('../src/staff-auth-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

test('rejects invalid identity and configuration before database access', async () => {
  let calls = 0;
  const fake = { async query() { calls++; throw new Error('database unavailable'); } };
  assert.throws(() => createLoginAttemptLimit({ pool: fake, businessId: '' }), /business ID/);
  assert.throws(() => createLoginAttemptLimit({ pool: {}, businessId: 'a' }), /pool/);
  const limit = createLoginAttemptLimit({ pool: fake, businessId: 'fictional-business' });
  for (const email of ['', 'not-an-email', 'staff@example.test\nBcc:unsafe@example.test']) {
    await assert.rejects(limit.reserve(email), error => error instanceof StaffAuthError && error.code === 'INVALID_EMAIL');
  }
  assert.equal(calls, 0);
  await assert.rejects(limit.reserve('valid@example.test'), /database unavailable/);
  assert.equal(calls, 1);
});

test('isolated PostgreSQL: atomic limits, expiry, normalization and business isolation',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 12 });
    const businessId = `limit-${crypto.randomUUID()}`;
    const otherBusinessId = `limit-${crypto.randomUUID()}`;
    const email = `fictional-${crypto.randomUUID()}@example.test`;
    const secondEmail = `fictional-${crypto.randomUUID()}@example.test`;
    const limit = createLoginAttemptLimit({ pool, businessId });
    const anotherProcess = createLoginAttemptLimit({ pool, businessId });
    const foreign = createLoginAttemptLimit({ pool, businessId: otherBusinessId });
    try {
      // A single atomic UPSERT enforces the ceiling across concurrent connections.
      const reservations = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? limit : anotherProcess).reserve(index % 2 ? email.toUpperCase() : email)
      ));
      assert.equal(reservations.filter(Boolean).length, 9);
      assert.equal(reservations.filter(value => !value).length, 11);
      assert.equal(await limit.reserve(email), false);
      const digest = crypto.createHash('sha256').update(email).digest();
      const row = await pool.query(
        'SELECT identity_hash, attempts, blocked_until FROM facturations_login_attempt_limits WHERE business_id=$1',
        [businessId]
      );
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].identity_hash.toString('hex'), digest.toString('hex'));
      assert.equal(row.rows[0].attempts, 10);
      assert.ok(row.rows[0].blocked_until);
      assert.equal(await foreign.reserve(email), true);
      assert.equal(await limit.reserve(secondEmail), true);

      // Manipulate time ONLY in the disposable localhost fixture.
      await pool.query(
        "UPDATE facturations_login_attempt_limits SET window_started_at=now()-interval '40 minutes', blocked_until=now()-interval '1 minute' WHERE business_id=$1 AND identity_hash=$2",
        [businessId, digest]
      );
      assert.equal(await limit.reserve(email), true);
      const restarted = await pool.query(
        'SELECT attempts, blocked_until FROM facturations_login_attempt_limits WHERE business_id=$1 AND identity_hash=$2',
        [businessId, digest]
      );
      assert.equal(restarted.rows[0].attempts, 1);
      assert.equal(restarted.rows[0].blocked_until, null);
      assert.equal(await foreign.reset(email), true);
      assert.equal(await limit.reset(email), true);
      assert.equal(await limit.reset(email), false);
      assert.equal(await limit.reserve(email), true);
    } finally {
      await pool.end();
    }
  });
