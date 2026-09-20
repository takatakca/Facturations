'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-logout-all-password-2026';

test('logout-all rejects malformed staff IDs without querying storage', async () => {
  let calls = 0;
  const store = createStaffAuthStore({
    businessId: 'fictional-company',
    pool: { connect() {}, query() { calls++; throw Error('Storage must not be contacted'); } },
  });
  for (const staffId of [undefined, null, '', 'not-a-uuid', '1'.repeat(36),
    '11111111-1111-4111-8111-111111111111\n']) {
    await assert.rejects(store.revokeAllSessionsForStaff(staffId), error =>
      error instanceof StaffAuthError && error.code === 'INVALID_STAFF_ID' && error.statusCode === 422);
  }
  assert.equal(calls, 0);
});

test('disposable PostgreSQL: logout-all revokes only one employee in one business, including repeated calls',
  { skip: !DATABASE }, async () => {
    const parsed = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname));
    assert.equal(parsed.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const businessId = 'revocation-' + crypto.randomUUID();
    const foreignId = 'other-revocation-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId });
    const foreignAuth = createStaffAuthStore({ pool, businessId: foreignId });
    const invites = createStaffInvitationStore({ pool, businessId });
    const foreignInvites = createStaffInvitationStore({ pool, businessId: foreignId });
    const person = 'employee-' + crypto.randomUUID() + '@example.test';
    const colleague = 'colleague-' + crypto.randomUUID() + '@example.test';
    const outsider = 'outsider-' + crypto.randomUUID() + '@example.test';
    try {
      const first = await auth.createPendingStaff({ email: person, password: PASSWORD });
      const second = await auth.createPendingStaff({ email: colleague, password: PASSWORD });
      const third = await foreignAuth.createPendingStaff({ email: outsider, password: PASSWORD });
      for (const employee of [first, second]) {
        const invitation = await invites.issueInvitation({ staffId: employee.id });
        await invites.redeemInvitation({ token: invitation.token, password: PASSWORD });
      }
      const foreignInvitation = await foreignInvites.issueInvitation({ staffId: third.id });
      await foreignInvites.redeemInvitation({ token: foreignInvitation.token, password: PASSWORD });
      const firstSessions = await Promise.all(Array.from({ length: 3 }, () =>
        auth.authenticate({ email: person, password: PASSWORD })));
      const colleagueSession = await auth.authenticate({ email: colleague, password: PASSWORD });
      const foreignSession = await foreignAuth.authenticate({ email: outsider, password: PASSWORD });
      for (const session of firstSessions) assert.equal((await auth.getSession(session.token)).id, first.id);
      assert.equal(await foreignAuth.revokeAllSessionsForStaff(first.id), 0);
      assert.equal((await auth.getSession(firstSessions[0].token)).id, first.id);
      assert.equal(await auth.revokeAllSessionsForStaff(first.id), 3);
      for (const session of firstSessions) assert.equal(await auth.getSession(session.token), null);
      assert.equal(await auth.revokeAllSessionsForStaff(first.id), 0);
      assert.equal((await auth.getSession(colleagueSession.token)).id, second.id);
      assert.equal((await foreignAuth.getSession(foreignSession.token)).id, third.id);
      assert.equal(await auth.revokeAllSessionsForStaff(third.id), 0);
      assert.equal((await foreignAuth.getSession(foreignSession.token)).id, third.id);
    } finally {
      await pool.end();
    }
  });
