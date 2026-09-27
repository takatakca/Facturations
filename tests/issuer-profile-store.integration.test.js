'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const {
  createIssuerProfileStore,
  IssuerProfileError,
} = require('../src/issuer-profile-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provisionOwner({ auth, invitations, password }) {
  const owner = await auth.createPendingStaff({
    email: 'issuer-owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invitations.issueInvitation({ staffId: owner.id });
  await invitations.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

function verifiedInput({ owner, session, suffix = 'v1', legalName = 'Synthetic Legal Inc.' }) {
  return {
    confirmation: 'VERIFY_ISSUER_PROFILE',
    legalName,
    displayName: 'GROUPE TAKATAK Synthetic',
    addressLines: ['123 Example Street', 'Suite 100'],
    city: 'Montréal',
    region: 'QC',
    postalCode: 'H0H 0H0',
    countryCode: 'CA',
    contactEmail: 'billing-' + suffix + '@example.test',
    contactPhone: '+1 514 555 0100',
    taxRegistrations: [
      { scheme: 'GST', registrationNumber: 'SYNTHETIC-GST-' + suffix },
      { scheme: 'QST', registrationNumber: 'SYNTHETIC-QST-' + suffix },
    ],
    verificationMethod: 'HUMAN_DOCUMENT_REVIEW',
    verificationReference: 'synthetic-review-' + suffix,
    ownerId: owner.id,
    sessionToken: session.token,
  };
}

test('verified issuer profiles are OWNER-only, versioned, idempotent and immutable', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issuer-profile-' + crypto.randomUUID();
  const password = 'synthetic-issuer-profile-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const profiles = createIssuerProfileStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invitations, password });

    const firstInput = verifiedInput({ owner, session, suffix: 'first' });
    const first = await profiles.createVerified(firstInput);

    assert.equal(first.version, 1);
    assert.equal(first.state, 'VERIFIED');
    assert.equal(first.legalName, 'Synthetic Legal Inc.');
    assert.equal(first.displayName, 'GROUPE TAKATAK Synthetic');
    assert.equal(first.countryCode, 'CA');
    assert.match(first.profileHash, /^[a-f0-9]{64}$/);
    assert.equal(first.verifiedBy, owner.id);
    assert.deepEqual(first.taxRegistrations, [
      { scheme: 'GST', registrationNumber: 'SYNTHETIC-GST-first' },
      { scheme: 'QST', registrationNumber: 'SYNTHETIC-QST-first' },
    ]);

    const retry = await profiles.createVerified(firstInput);
    assert.equal(retry.id, first.id);
    assert.equal(retry.version, 1);
    assert.equal(retry.profileHash, first.profileHash);

    const secondInput = verifiedInput({
      owner,
      session,
      suffix: 'second',
      legalName: 'Synthetic Legal Holdings Inc.',
    });
    const second = await profiles.createVerified(secondInput);
    assert.equal(second.version, 2);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.profileHash, first.profileHash);

    const latest = await profiles.getLatest();
    assert.equal(latest.id, second.id);
    assert.equal(latest.version, 2);

    const loadedFirst = await profiles.getById({ profileId: first.id });
    assert.equal(loadedFirst.version, 1);
    assert.equal(loadedFirst.legalName, first.legalName);

    const differentEvidence = { ...firstInput, verificationReference: 'another-review-reference' };
    await assert.rejects(
      profiles.createVerified(differentEvidence),
      error => error instanceof IssuerProfileError &&
        error.code === 'PROFILE_ALREADY_VERIFIED_DIFFERENT_EVIDENCE' &&
        error.statusCode === 409
    );

    const foreign = createIssuerProfileStore({
      pool,
      businessId: 'issuer-profile-other-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.getById({ profileId: first.id }),
      error => error instanceof IssuerProfileError &&
        error.code === 'ISSUER_PROFILE_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_issuer_profiles SET display_name=display_name
          WHERE business_id=$1 AND id=$2`,
        [businessId, first.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issuer_profiles WHERE business_id=$1 AND id=$2',
        [businessId, first.id]
      ),
      error => error && error.code === '23514'
    );

    const rows = await pool.query(
      `SELECT profile_version,state,count(*)::integer AS n
         FROM facturations_issuer_profiles
        WHERE business_id=$1
        GROUP BY profile_version,state
        ORDER BY profile_version`,
      [businessId]
    );
    assert.deepEqual(rows.rows, [
      { profile_version: 1, state: 'VERIFIED', n: 1 },
      { profile_version: 2, state: 'VERIFIED', n: 1 },
    ]);
  } finally {
    await pool.end();
  }
});
