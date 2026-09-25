'use strict';

const crypto = require('node:crypto');
const { hasUnpairedSurrogate } = require('./unicode-validation');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TAX_CODE = /^[A-Z][A-Z0-9_-]{0,19}$/;
const CREATE_CONFIRMATION = 'CREATE_ISSUER_PROFILE_VERSION';
const VERIFY_CONFIRMATION = 'VERIFY_ISSUER_PROFILE_FOR_INVOICING';

class IssuerProfileError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuerProfileError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new IssuerProfileError(code);
  return value.toLowerCase();
}

function text(value, max, code, required = true) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new IssuerProfileError(code);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max ||
      /[\u0000-\u001f\u007f]/u.test(cleaned) || hasUnpairedSurrogate(cleaned)) {
    throw new IssuerProfileError(code);
  }
  return cleaned || null;
}

function email(value) {
  const result = text(value, 254, 'INVALID_ISSUER_EMAIL');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) {
    throw new IssuerProfileError('INVALID_ISSUER_EMAIL');
  }
  return result.toLowerCase();
}

function taxIdentifiers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IssuerProfileError('INVALID_TAX_IDENTIFIERS');
  }
  const entries = Object.entries(value);
  if (entries.length > 10) throw new IssuerProfileError('INVALID_TAX_IDENTIFIERS');
  const output = {};
  for (const [key, raw] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!TAX_CODE.test(key)) throw new IssuerProfileError('INVALID_TAX_IDENTIFIER_CODE');
    output[key] = text(raw, 80, 'INVALID_TAX_IDENTIFIER_VALUE');
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 4096) {
    throw new IssuerProfileError('INVALID_TAX_IDENTIFIERS');
  }
  return Object.freeze(output);
}

function validateCreate(input) {
  const expected = [
    'addressLine1','addressLine2','businessRegistrationNumber','city','confirmation',
    'countryCode','email','legalName','ownerId','phone','postalCode','region',
    'sessionToken','taxIdentifiers','tradeName',
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== expected.sort().join(',')) {
    throw new IssuerProfileError('INVALID_ISSUER_PROFILE');
  }
  if (input.confirmation !== CREATE_CONFIRMATION) {
    throw new IssuerProfileError('CREATE_CONFIRMATION_REQUIRED');
  }
  const countryCode = text(input.countryCode, 2, 'INVALID_COUNTRY_CODE');
  if (!/^[A-Z]{2}$/u.test(countryCode)) throw new IssuerProfileError('INVALID_COUNTRY_CODE');
  const ownerId = uuid(input.ownerId, 'INVALID_OWNER_ID');
  if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new IssuerProfileError('INVALID_SESSION', 401);
  }
  const profile = Object.freeze({
    legalName: text(input.legalName, 200, 'INVALID_LEGAL_NAME'),
    tradeName: text(input.tradeName, 200, 'INVALID_TRADE_NAME', false),
    addressLine1: text(input.addressLine1, 200, 'INVALID_ADDRESS_LINE1'),
    addressLine2: text(input.addressLine2, 200, 'INVALID_ADDRESS_LINE2', false),
    city: text(input.city, 120, 'INVALID_CITY'),
    region: text(input.region, 120, 'INVALID_REGION'),
    postalCode: text(input.postalCode, 24, 'INVALID_POSTAL_CODE'),
    countryCode,
    email: email(input.email),
    phone: text(input.phone, 40, 'INVALID_PHONE', false),
    businessRegistrationNumber: text(
      input.businessRegistrationNumber, 80, 'INVALID_BUSINESS_REGISTRATION_NUMBER', false
    ),
    taxIdentifiers: taxIdentifiers(input.taxIdentifiers),
  });
  return Object.freeze({ ownerId, sessionToken: input.sessionToken, profile });
}

function canonicalProfile(profile) {
  return JSON.stringify({
    legalName: profile.legalName,
    tradeName: profile.tradeName,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    region: profile.region,
    postalCode: profile.postalCode,
    countryCode: profile.countryCode,
    email: profile.email,
    phone: profile.phone,
    businessRegistrationNumber: profile.businessRegistrationNumber,
    taxIdentifiers: profile.taxIdentifiers,
  });
}

function profileResult(row, verification = null) {
  return Object.freeze({
    id: row.id,
    versionNumber: Number(row.version_number),
    legalName: row.legal_name,
    tradeName: row.trade_name || null,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2 || null,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    email: row.email,
    phone: row.phone || null,
    businessRegistrationNumber: row.business_registration_number || null,
    taxIdentifiers: Object.freeze({ ...(row.tax_identifiers || {}) }),
    profileHash: row.profile_hash,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    verified: Boolean(verification),
    verifiedBy: verification?.verified_by || null,
    verifiedAt: verification?.verified_at instanceof Date
      ? verification.verified_at.toISOString() : (verification?.verified_at || null),
  });
}

async function requireOwner(client, tenant, ownerId, sessionToken) {
  const digest = crypto.createHash('sha256').update(sessionToken, 'utf8').digest();
  const owner = await client.query(
    `SELECT u.id
       FROM facturations_staff_sessions AS s
       JOIN facturations_staff_users AS u
         ON u.business_id=s.business_id AND u.id=s.user_id
      WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
      FOR SHARE OF s,u`,
    [tenant, ownerId, digest]
  );
  if (!owner.rows.length) throw new IssuerProfileError('OWNER_AUTH_REQUIRED', 403);
}

function createIssuerProfileStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function createVersion(input) {
    const fields = validateCreate(input);
    const profileHash = crypto.createHash('sha256')
      .update('facturations-issuer-profile-v1\0')
      .update(canonicalProfile(fields.profile), 'utf8')
      .digest('hex');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await requireOwner(client, tenant, fields.ownerId, fields.sessionToken);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant]);

      const existing = await client.query(
        'SELECT * FROM facturations_issuer_profile_versions WHERE business_id=$1 AND profile_hash=$2',
        [tenant, profileHash]
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        transaction = false;
        return profileResult(existing.rows[0]);
      }

      const next = await client.query(
        'SELECT COALESCE(MAX(version_number),0)::integer + 1 AS version_number FROM facturations_issuer_profile_versions WHERE business_id=$1',
        [tenant]
      );
      const versionNumber = next.rows[0].version_number;
      const p = fields.profile;
      const inserted = await client.query(
        `INSERT INTO facturations_issuer_profile_versions
           (business_id,version_number,legal_name,trade_name,address_line1,address_line2,
            city,region,postal_code,country_code,email,phone,business_registration_number,
            tax_identifiers,profile_hash,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
         RETURNING *`,
        [
          tenant, versionNumber, p.legalName, p.tradeName, p.addressLine1, p.addressLine2,
          p.city, p.region, p.postalCode, p.countryCode, p.email, p.phone,
          p.businessRegistrationNumber, JSON.stringify(p.taxIdentifiers), profileHash,
          fields.ownerId,
        ]
      );
      await client.query('COMMIT');
      transaction = false;
      return profileResult(inserted.rows[0]);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function verify(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'confirmation,ownerId,profileVersionId,sessionToken') {
      throw new IssuerProfileError('INVALID_ISSUER_PROFILE_VERIFICATION');
    }
    if (input.confirmation !== VERIFY_CONFIRMATION) {
      throw new IssuerProfileError('VERIFICATION_CONFIRMATION_REQUIRED');
    }
    const profileVersionId = uuid(input.profileVersionId, 'INVALID_PROFILE_VERSION_ID');
    const ownerId = uuid(input.ownerId, 'INVALID_OWNER_ID');
    if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
      throw new IssuerProfileError('INVALID_SESSION', 401);
    }

    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await requireOwner(client, tenant, ownerId, input.sessionToken);
      const profile = await client.query(
        'SELECT * FROM facturations_issuer_profile_versions WHERE business_id=$1 AND id=$2 FOR SHARE',
        [tenant, profileVersionId]
      );
      if (!profile.rows.length) throw new IssuerProfileError('PROFILE_VERSION_NOT_FOUND', 404);

      const inserted = await client.query(
        `INSERT INTO facturations_issuer_profile_verifications
           (business_id,profile_version_id,verified_by,confirmation)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id,profile_version_id) DO NOTHING
         RETURNING *`,
        [tenant, profileVersionId, ownerId, VERIFY_CONFIRMATION]
      );
      let verification = inserted.rows[0];
      if (!verification) {
        const prior = await client.query(
          'SELECT * FROM facturations_issuer_profile_verifications WHERE business_id=$1 AND profile_version_id=$2',
          [tenant, profileVersionId]
        );
        verification = prior.rows[0];
      }
      await client.query('COMMIT');
      transaction = false;
      return profileResult(profile.rows[0], verification);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getLatestVerified() {
    const found = await pool.query(
      `SELECT p.*,v.verified_by,v.verified_at
         FROM facturations_issuer_profile_versions AS p
         JOIN facturations_issuer_profile_verifications AS v
           ON v.business_id=p.business_id AND v.profile_version_id=p.id
        WHERE p.business_id=$1
        ORDER BY p.version_number DESC
        LIMIT 1`,
      [tenant]
    );
    if (!found.rows.length) throw new IssuerProfileError('VERIFIED_ISSUER_PROFILE_NOT_FOUND', 404);
    return profileResult(found.rows[0], found.rows[0]);
  }

  async function getVerifiedById(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'profileVersionId') {
      throw new IssuerProfileError('INVALID_PROFILE_LOOKUP');
    }
    const profileVersionId = uuid(input.profileVersionId, 'INVALID_PROFILE_VERSION_ID');
    const found = await pool.query(
      `SELECT p.*,v.verified_by,v.verified_at
         FROM facturations_issuer_profile_versions AS p
         JOIN facturations_issuer_profile_verifications AS v
           ON v.business_id=p.business_id AND v.profile_version_id=p.id
        WHERE p.business_id=$1 AND p.id=$2`,
      [tenant, profileVersionId]
    );
    if (!found.rows.length) throw new IssuerProfileError('VERIFIED_ISSUER_PROFILE_NOT_FOUND', 404);
    return profileResult(found.rows[0], found.rows[0]);
  }

  return Object.freeze({ createVersion, verify, getLatestVerified, getVerifiedById });
}

module.exports = {
  createIssuerProfileStore,
  IssuerProfileError,
  ISSUER_PROFILE_CREATE_CONFIRMATION: CREATE_CONFIRMATION,
  ISSUER_PROFILE_VERIFY_CONFIRMATION: VERIFY_CONFIRMATION,
};
