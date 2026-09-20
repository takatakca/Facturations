'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError, normalizeEmail } = require('../src/staff-auth-store');
const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-strong-password-2026';
const invalidCredentials = error => error instanceof StaffAuthError && error.code === 'INVALID_CREDENTIALS' && error.statusCode === 401;

test('email and password validation refuse malformed provisioning inputs', async () => {
  assert.equal(normalizeEmail('  STAFF@EXAMPLE.TEST  '), 'staff@example.test');
  for (const email of ['bad', 'a@b', 'a..b@example.test', 'a@example.test\nBcc:bad@example.test', '']) assert.throws(() => normalizeEmail(email), StaffAuthError);
  const fake = { connect() {}, query() {} }; assert.throws(() => createStaffAuthStore({ pool: fake, businessId: '' }), /business ID/);
  const store = createStaffAuthStore({ pool: fake, businessId: 'test-business' });
  await assert.rejects(store.createPendingStaff({ email: 'staff@example.test', password: 'short' }), e => e instanceof StaffAuthError && e.code === 'INVALID_PASSWORD');
  await assert.rejects(store.createPendingStaff({ email: 'staff@example.test', password: PASSWORD, role: 'SUPERADMIN' }), e => e instanceof StaffAuthError && e.code === 'INVALID_ROLE');
  await assert.rejects(store.revokeAllSessionsForStaff('not-a-uuid'), e => e instanceof StaffAuthError && e.code === 'INVALID_STAFF_ID');
});

test('isolated PostgreSQL: unverified identity, lockout, tenant isolation, expiry and revocation', { skip: !DATABASE }, async () => {
  const url = new URL(DATABASE); assert.ok(['localhost', '127.0.0.1'].includes(url.hostname)); assert.equal(url.pathname, '/facturations_test');
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'auth-test-' + crypto.randomUUID(); const email = 'fictional-' + crypto.randomUUID() + '@example.test';
  const store = createStaffAuthStore({ pool, businessId }); const foreign = createStaffAuthStore({ pool, businessId: 'other-' + crypto.randomUUID() });
  try {
    const pending = await store.createPendingStaff({ email: email.toUpperCase(), password: PASSWORD, role: 'OWNER' });
    assert.equal(pending.email, email); assert.equal(pending.emailVerified, false); assert.equal(pending.role, 'OWNER');
    await assert.rejects(store.createPendingStaff({ email, password: PASSWORD }), e => e instanceof StaffAuthError && e.code === 'STAFF_ALREADY_EXISTS');
    await assert.rejects(store.authenticate({ email, password: PASSWORD }), invalidCredentials); await assert.rejects(store.authenticate({ email: 'absent@example.test', password: PASSWORD }), invalidCredentials);
    await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2', [businessId, pending.id]);
    for (let i = 0; i < 5; i++) await assert.rejects(store.authenticate({ email, password: 'incorrect-password-12345' }), invalidCredentials);
    const locked = await pool.query('SELECT failed_attempts,locked_until FROM facturations_staff_users WHERE id=$1', [pending.id]); assert.equal(locked.rows[0].failed_attempts, 5); assert.ok(locked.rows[0].locked_until);
    await assert.rejects(store.authenticate({ email, password: PASSWORD }), invalidCredentials);
    await pool.query("UPDATE facturations_staff_users SET locked_until=now()-interval '1 minute' WHERE id=$1", [pending.id]);
    const session = await store.authenticate({ email, password: PASSWORD }); assert.match(session.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(session.staff.role, 'OWNER'); assert.equal(session.staff.businessId, businessId);
    assert.deepEqual(await store.getSession(session.token), session.staff); assert.equal(await foreign.getSession(session.token), null); assert.equal(await foreign.revokeSession(session.token), false);
    const stored = await pool.query('SELECT token_hash,revoked_at FROM facturations_staff_sessions WHERE business_id=$1', [businessId]); assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].token_hash.toString('hex'), crypto.createHash('sha256').update(session.token).digest('hex'));
    assert.equal(await store.getSession('invalid-token'), null); assert.equal(await store.revokeSession(session.token), true); assert.equal(await store.revokeSession(session.token), false); assert.equal(await store.getSession(session.token), null);
    const second = await store.authenticate({ email, password: PASSWORD }); await pool.query("UPDATE facturations_staff_sessions SET created_at=now()-interval '2 days', expires_at=now()-interval '1 minute' WHERE business_id=$1 AND token_hash=$2", [businessId, crypto.createHash('sha256').update(second.token).digest()]); assert.equal(await store.getSession(second.token), null);
    const third = await store.authenticate({ email, password: PASSWORD });
    const fourth = await store.authenticate({ email, password: PASSWORD });
    assert.equal(await foreign.revokeAllSessionsForStaff(pending.id), 0);
    assert.deepEqual(await store.getSession(third.token), third.staff); assert.deepEqual(await store.getSession(fourth.token), fourth.staff);
    assert.equal(await store.revokeAllSessionsForStaff(pending.id), 2);
    assert.equal(await store.getSession(third.token), null); assert.equal(await store.getSession(fourth.token), null); assert.equal(await store.revokeAllSessionsForStaff(pending.id), 0);
    const fifth = await store.authenticate({ email, password: PASSWORD }); await pool.query('UPDATE facturations_staff_users SET enabled=false WHERE business_id=$1 AND id=$2', [businessId, pending.id]); assert.equal(await store.getSession(fifth.token), null); await assert.rejects(store.authenticate({ email, password: PASSWORD }), invalidCredentials);
  } finally { await pool.end(); }
});
