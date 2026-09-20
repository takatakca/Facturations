'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const INITIAL_PASSWORD = 'fictional-initial-password-2026';
const NEW_PASSWORD = 'fictional-activated-password-2026';
const invalidInvite = e => e instanceof StaffAuthError && e.code === 'INVALID_INVITATION' && e.statusCode === 401;

function assertDisposableDatabase() {
  const url = new URL(DATABASE);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
}

test('invitation provisioning rejects invalid staff IDs and unsafe passwords before DB access', async () => {
  const pool = { query() { throw new Error('DB must not be reached'); }, connect() { throw new Error('DB must not be reached'); } };
  const store = createStaffInvitationStore({ pool, businessId: 'fictional-business' });
  await assert.rejects(store.issueInvitation({ staffId: 'not-a-uuid' }), e => e.code === 'INVALID_STAFF_ID');
  await assert.rejects(store.redeemInvitation({ token: 'invalid', password: NEW_PASSWORD }), invalidInvite);
  await assert.rejects(store.redeemInvitation({ token: 'A'.repeat(43), password: 'short' }), e => e.code === 'INVALID_PASSWORD');
  await assert.rejects(store.redeemInvitation({ token: 'A'.repeat(43), password: 'bad\npassword-2026' }), e => e.code === 'INVALID_PASSWORD');
  assert.throws(() => createStaffInvitationStore({ pool, businessId: '' }), /business ID/);
});

test('disposable PostgreSQL: scoped invite, reissue, one-time redemption and password replacement',
  { skip: !DATABASE }, async () => {
    assertDisposableDatabase();
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'invite-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    const invites = createStaffInvitationStore({ pool, businessId: tenant });
    const foreign = createStaffInvitationStore({ pool, businessId: 'foreign-' + crypto.randomUUID() });
    const email = 'member-' + crypto.randomUUID() + '@example.test';
    try {
      const pending = await auth.createPendingStaff({ email, password: INITIAL_PASSWORD });
      await assert.rejects(auth.authenticate({ email, password: INITIAL_PASSWORD }), e => e.code === 'INVALID_CREDENTIALS');
      await assert.rejects(invites.issueInvitation({ staffId: crypto.randomUUID() }), e => e.code === 'STAFF_NOT_FOUND');
      const first = await invites.issueInvitation({ staffId: pending.id });
      assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(new Date(first.expiresAt) > new Date());
      const second = await invites.issueInvitation({ staffId: pending.id });
      assert.notEqual(first.token, second.token);
      await assert.rejects(invites.redeemInvitation({ token: first.token, password: NEW_PASSWORD }), invalidInvite);
      await assert.rejects(foreign.redeemInvitation({ token: second.token, password: NEW_PASSWORD }), invalidInvite);
      const rows = await pool.query(
        'SELECT token_hash,consumed_at,revoked_at FROM facturations_staff_invitations WHERE business_id=$1 ORDER BY created_at', [tenant]
      );
      assert.equal(rows.rows.length, 2);
      assert.ok(rows.rows.every(row => !row.token_hash.toString('hex').includes(second.token)));
      assert.ok(rows.rows.some(row => row.revoked_at));

      const activated = await invites.redeemInvitation({ token: second.token, password: NEW_PASSWORD });
      assert.equal(activated.id, pending.id);
      assert.equal(activated.emailVerified, true);
      assert.equal(activated.businessId, tenant);
      await assert.rejects(invites.redeemInvitation({ token: second.token, password: NEW_PASSWORD }), invalidInvite);
      await assert.rejects(invites.issueInvitation({ staffId: pending.id }), e => e.code === 'STAFF_NOT_PENDING');
      await assert.rejects(auth.authenticate({ email, password: INITIAL_PASSWORD }), e => e.code === 'INVALID_CREDENTIALS');
      const session = await auth.authenticate({ email, password: NEW_PASSWORD });
      assert.equal(session.staff.id, pending.id);
      assert.equal(await auth.revokeSession(session.token), true);
    } finally {
      await pool.end();
    }
  });

test('disposable PostgreSQL: expiry and concurrent redemption fail closed',
  { skip: !DATABASE }, async () => {
    assertDisposableDatabase();
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = 'invite-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId: tenant });
    const invites = createStaffInvitationStore({ pool, businessId: tenant });
    try {
      const expiredStaff = await auth.createPendingStaff({
        email: 'expired-' + crypto.randomUUID() + '@example.test', password: INITIAL_PASSWORD,
      });
      const expired = await invites.issueInvitation({ staffId: expiredStaff.id });
      await pool.query(
        `UPDATE facturations_staff_invitations
            SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day'
          WHERE business_id=$1 AND token_hash=$2`,
        [tenant, crypto.createHash('sha256').update(expired.token).digest()]
      );
      await assert.rejects(invites.redeemInvitation({ token: expired.token, password: NEW_PASSWORD }), invalidInvite);
      const stillPending = await pool.query(
        'SELECT email_verified_at FROM facturations_staff_users WHERE business_id=$1 AND id=$2',
        [tenant, expiredStaff.id]
      );
      assert.equal(stillPending.rows[0].email_verified_at, null);

      const concurrent = await auth.createPendingStaff({
        email: 'concurrent-' + crypto.randomUUID() + '@example.test', password: INITIAL_PASSWORD,
      });
      const invite = await invites.issueInvitation({ staffId: concurrent.id });
      const results = await Promise.allSettled([
        invites.redeemInvitation({ token: invite.token, password: NEW_PASSWORD }),
        invites.redeemInvitation({ token: invite.token, password: NEW_PASSWORD }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected' && invalidInvite(r.reason)).length, 1);
      const consumed = await pool.query(
        'SELECT count(*)::integer AS n FROM facturations_staff_invitations WHERE business_id=$1 AND consumed_at IS NOT NULL',
        [tenant]
      );
      assert.equal(consumed.rows[0].n, 1);
    } finally {
      await pool.end();
    }
  });
