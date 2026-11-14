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

async function ownerFixture({ auth, invitations, password }) {
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

function input({ owner, session, suffix, city = 'Montréal' }) {
  return {
    confirmation: 'CREATE_ISSUER_PROFILE_VERSION',
    ownerId: owner.id,
    sessionToken: session.token,
    legalName: 'Example Legal Company ' + suffix,
    tradeName: 'Example Trade ' + suffix,
    addressLine1: '100 rue Exemple',
    addressLine2: null,
    city,
    region: 'Québec',
    postalCode: 'H0H 0H0',
    countryCode: 'CA',
    email: 'billing-' + suffix + '@example.test',
    phone: '+1 514 555 0100',
    businessRegistrationNumber: 'SYNTHETIC-REG-' + suffix,
    taxIdentifiers: {
      GST: 'SYNTHETIC-GST-' + suffix,
      QST: 'SYNTHETIC-QST-' + suffix,
    },
  };
}

test('issuer profiles are versioned, explicitly verified and immutable', {
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
    const { owner, session } = await ownerFixture({ auth, invitations, password });

    await assert.rejects(
      profiles.getLatestVerified(),
      error => error instanceof IssuerProfileError &&
        error.code === 'VERIFIED_ISSUER_PROFILE_NOT_FOUND' &&
        error.statusCode === 404
    );

    const v1 = await profiles.createVersion(input({ owner, session, suffix: 'V1' }));
    assert.equal(v1.versionNumber, 1);
    assert.equal(v1.verified, false);
    assert.match(v1.profileHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(v1.taxIdentifiers, {
      GST: 'SYNTHETIC-GST-V1',
      QST: 'SYNTHETIC-QST-V1',
    });

    const v1Repeated = await profiles.createVersion(input({ owner, session, suffix: 'V1' }));
    assert.equal(v1Repeated.id, v1.id);
    assert.equal(v1Repeated.versionNumber, 1);

    const verifiedV1 = await profiles.verify({
      confirmation: 'VERIFY_ISSUER_PROFILE_FOR_INVOICING',
      ownerId: owner.id,
      sessionToken: session.token,
      profileVersionId: v1.id,
    });
    assert.equal(verifiedV1.id, v1.id);
    assert.equal(verifiedV1.verified, true);
    assert.equal(verifiedV1.verifiedBy, owner.id);
    assert.ok(verifiedV1.verifiedAt);

    const verifiedV1Again = await profiles.verify({
      confirmation: 'VERIFY_ISSUER_PROFILE_FOR_INVOICING',
      ownerId: owner.id,
      sessionToken: session.token,
      profileVersionId: v1.id,
    });
    assert.equal(verifiedV1Again.verifiedAt, verifiedV1.verifiedAt);

    const v2 = await profiles.createVersion(input({
      owner,
      session,
      suffix: 'V2',
      city: 'Québec',
    }));
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.verified, false);

    const latestBeforeV2Verification = await profiles.getLatestVerified();
    assert.equal(latestBeforeV2Verification.id, v1.id);

    const verifiedV2 = await profiles.verify({
      confirmation: 'VERIFY_ISSUER_PROFILE_FOR_INVOICING',
      ownerId: owner.id,
      sessionToken: session.token,
      profileVersionId: v2.id,
    });
    assert.equal(verifiedV2.verified, true);

    const latest = await profiles.getLatestVerified();
    assert.equal(latest.id, v2.id);
    assert.equal(latest.versionNumber, 2);
    assert.equal(latest.city, 'Québec');

    const byId = await profiles.getVerifiedById({ profileVersionId: v1.id });
    assert.equal(byId.id, v1.id);
    assert.equal(byId.versionNumber, 1);

    const foreign = createIssuerProfileStore({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.getVerifiedById({ profileVersionId: v1.id }),
      error => error instanceof IssuerProfileError &&
        error.code === 'VERIFIED_ISSUER_PROFILE_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        'UPDATE facturations_issuer_profile_versions SET city=$3 WHERE business_id=$1 AND id=$2',
        [businessId, v1.id, 'Changed']
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issuer_profile_versions WHERE business_id=$1 AND id=$2',
        [businessId, v1.id]
      ),
      error => error && error.code === '23514'
    );

    const verificationRow = await pool.query(
      'SELECT id FROM facturations_issuer_profile_verifications WHERE business_id=$1 AND profile_version_id=$2',
      [businessId, v1.id]
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issuer_profile_verifications WHERE business_id=$1 AND id=$2',
        [businessId, verificationRow.rows[0].id]
      ),
      error => error && error.code === '23514'
    );

    const counts = await pool.query(
      `SELECT
        (SELECT count(*)::integer FROM facturations_issuer_profile_versions WHERE business_id=$1) AS versions,
        (SELECT count(*)::integer FROM facturations_issuer_profile_verifications WHERE business_id=$1) AS verifications`,
      [businessId]
    );
    assert.deepEqual(counts.rows, [{ versions: 2, verifications: 2 }]);
  } finally {
    await pool.end();
  }
});
