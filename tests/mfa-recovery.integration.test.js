'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');
const { createMfaRecoveryStore, MfaRecoveryError } = require('../src/mfa-recovery-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const ENCRYPTION_KEY = 'ef'.repeat(32);
const PASSWORD = 'synthetic-recovery-password-2026';

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

const invalidRecovery = error => error instanceof MfaRecoveryError &&
  error.code === 'INVALID_RECOVERY_CREDENTIALS' && error.statusCode === 401;

test('trusted owner MFA recovery is one-time, revokes sessions and requires new TOTP activation', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE, max: 10 });
  const businessId = 'mfa-recovery-' + crypto.randomUUID();
  const foreignBusinessId = 'mfa-recovery-foreign-' + crypto.randomUUID();
  let timestamp = 59000;

  const totp = createStaffTotpStore({
    pool, businessId, encryptionKeyHex: ENCRYPTION_KEY, now: () => timestamp,
  });
  const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const recovery = createMfaRecoveryStore({ pool, businessId, totpStore: totp });
  const foreignRecovery = createMfaRecoveryStore({
    pool,
    businessId: foreignBusinessId,
    totpStore: createStaffTotpStore({
      pool,
      businessId: foreignBusinessId,
      encryptionKeyHex: ENCRYPTION_KEY,
      now: () => timestamp,
    }),
  });

  try {
    const owner = await auth.createPendingStaff({
      email: 'owner-' + crypto.randomUUID() + '@example.test',
      password: PASSWORD,
      role: 'OWNER',
    });
    const invitation = await invitations.issueInvitation({ staffId: owner.id });
    await invitations.redeemInvitation({ token: invitation.token, password: PASSWORD });

    const initial = await totp.provisionTrusted(owner.id);
    const oldSecret = decodeBase32(initial.secretBase32);
    assert.equal(await totp.confirmTrusted(owner.id, oneTimeCode(oldSecret, 1)), true);

    timestamp = 89000;
    const originalSession = await auth.authenticateWithTotp({
      email: owner.email,
      password: PASSWORD,
      code: oneTimeCode(oldSecret, 2),
    });
    assert.deepEqual(await auth.getSession(originalSession.token), originalSession.staff);

    const first = await recovery.issueTrusted({
      confirmation: 'AUTHORIZE_OWNER_MFA_RECOVERY',
      staffId: owner.id,
      verificationMethod: 'HUMAN_OUT_OF_BAND',
      verificationReference: 'synthetic-identity-review-first',
    });
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);

    const second = await recovery.issueTrusted({
      confirmation: 'AUTHORIZE_OWNER_MFA_RECOVERY',
      staffId: owner.id,
      verificationMethod: 'HUMAN_OUT_OF_BAND',
      verificationReference: 'synthetic-identity-review-second',
    });
    assert.notEqual(second.authorizationId, first.authorizationId);
    assert.notEqual(second.token, first.token);

    await assert.rejects(
      recovery.redeem({ token: first.token, password: PASSWORD }),
      invalidRecovery
    );

    await assert.rejects(
      recovery.redeem({ token: second.token, password: 'wrong-recovery-password-2026' }),
      invalidRecovery
    );
    assert.deepEqual(
      await auth.getSession(originalSession.token),
      originalSession.staff,
      'wrong password must not revoke the existing authenticated session'
    );

    const concurrent = await Promise.allSettled([
      recovery.redeem({ token: second.token, password: PASSWORD }),
      recovery.redeem({ token: second.token, password: PASSWORD }),
    ]);
    const successes = concurrent.filter(result => result.status === 'fulfilled');
    const failures = concurrent.filter(result => result.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(invalidRecovery(failures[0].reason));

    const recovered = successes[0].value;
    assert.equal(recovered.authorizationId, second.authorizationId);
    assert.equal(recovered.staffId, owner.id);
    assert.equal(recovered.mustActivate, true);
    assert.match(recovered.secretBase32, /^[A-Z2-7]{32}$/);

    assert.equal(await auth.getSession(originalSession.token), null);

    const newSecret = decodeBase32(recovered.secretBase32);
    assert.equal(await totp.verify(owner.id, oneTimeCode(oldSecret, 2)), false);
    assert.equal(await totp.confirmTrusted(owner.id, oneTimeCode(newSecret, 2)), true);

    timestamp = 149000;
    const newSession = await auth.authenticateWithTotp({
      email: owner.email,
      password: PASSWORD,
      code: oneTimeCode(newSecret, 4),
    });
    assert.equal(newSession.staff.id, owner.id);
    assert.notEqual(newSession.token, originalSession.token);

    await assert.rejects(
      recovery.redeem({ token: second.token, password: PASSWORD }),
      invalidRecovery
    );
    await assert.rejects(
      foreignRecovery.redeem({ token: second.token, password: PASSWORD }),
      invalidRecovery
    );

    const events = await pool.query(
      `SELECT authorization_id,event_type,reason_code
         FROM facturations_mfa_recovery_events
        WHERE business_id=$1
        ORDER BY id`,
      [businessId]
    );
    assert.deepEqual(events.rows, [
      {
        authorization_id: first.authorizationId,
        event_type: 'ISSUED',
        reason_code: 'HUMAN_IDENTITY_VERIFIED',
      },
      {
        authorization_id: first.authorizationId,
        event_type: 'REVOKED',
        reason_code: 'SUPERSEDED_BY_NEW_RECOVERY',
      },
      {
        authorization_id: second.authorizationId,
        event_type: 'ISSUED',
        reason_code: 'HUMAN_IDENTITY_VERIFIED',
      },
      {
        authorization_id: second.authorizationId,
        event_type: 'CONSUMED',
        reason_code: 'TOTP_ROTATED_SESSIONS_REVOKED',
      },
    ]);

    await assert.rejects(
      pool.query(
        `UPDATE facturations_mfa_recovery_authorizations
            SET verification_reference=verification_reference
          WHERE business_id=$1 AND id=$2`,
        [businessId, second.authorizationId]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM facturations_mfa_recovery_events
          WHERE business_id=$1 AND authorization_id=$2`,
        [businessId, second.authorizationId]
      ),
      error => error && error.code === '23514'
    );
  } finally {
    await pool.end();
  }
});

test('trusted recovery issuance is OWNER-only', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'mfa-recovery-staff-' + crypto.randomUUID();
  const totp = createStaffTotpStore({
    pool, businessId, encryptionKeyHex: ENCRYPTION_KEY,
  });
  const auth = createStaffAuthStore({ pool, businessId });
  const recovery = createMfaRecoveryStore({ pool, businessId, totpStore: totp });

  try {
    const staff = await auth.createPendingStaff({
      email: 'staff-' + crypto.randomUUID() + '@example.test',
      password: PASSWORD,
      role: 'STAFF',
    });
    await pool.query(
      'UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
      [businessId, staff.id]
    );
    await assert.rejects(
      recovery.issueTrusted({
        confirmation: 'AUTHORIZE_OWNER_MFA_RECOVERY',
        staffId: staff.id,
        verificationMethod: 'HUMAN_OUT_OF_BAND',
        verificationReference: 'synthetic-staff-review',
      }),
      error => error instanceof MfaRecoveryError &&
        error.code === 'RECOVERABLE_OWNER_NOT_FOUND' &&
        error.statusCode === 404
    );
  } finally {
    await pool.end();
  }
});
