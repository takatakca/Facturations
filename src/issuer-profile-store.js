'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const COUNTRY = /^[A-Z]{2}$/;
const CONFIRMATION = 'VERIFY_ISSUER_PROFILE';
const METHOD = 'HUMAN_DOCUMENT_REVIEW';

class IssuerProfileError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuerProfileError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function safeText(value, max, code, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new IssuerProfileError(code);
  const text = value.trim();
  if ((required && !text) || text.length > max ||
      /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new IssuerProfileError(code);
  }
  return text || null;
}

function normalizeTaxRegistrations(value) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new IssuerProfileError('INVALID_TAX_REGISTRATIONS');
  }
  const seen = new Set();
  const normalized = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'registrationNumber,scheme') {
      throw new IssuerProfileError('INVALID_TAX_REGISTRATION');
    }
    const scheme = safeText(item.scheme, 40, 'INVALID_TAX_SCHEME').toUpperCase();
    const registrationNumber = safeText(
      item.registrationNumber, 80, 'INVALID_TAX_REGISTRATION_NUMBER'
    );
    const key = scheme + '\u0000' + registrationNumber.toUpperCase();
    if (seen.has(key)) throw new IssuerProfileError('DUPLICATE_TAX_REGISTRATION');
    seen.add(key);
    return Object.freeze({ scheme, registrationNumber });
  });
  normalized.sort((a, b) =>
    a.scheme.localeCompare(b.scheme, 'en') ||
    a.registrationNumber.localeCompare(b.registrationNumber, 'en'));
  return Object.freeze(normalized);
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'addressLines,city,confirmation,contactEmail,contactPhone,countryCode,displayName,legalName,ownerId,postalCode,region,sessionToken,taxRegistrations,verificationMethod,verificationReference') {
    throw new IssuerProfileError('INVALID_ISSUER_PROFILE');
  }
  if (input.confirmation !== CONFIRMATION) {
    throw new IssuerProfileError('PROFILE_VERIFICATION_CONFIRMATION_REQUIRED');
  }
  if (input.verificationMethod !== METHOD) {
    throw new IssuerProfileError('INVALID_VERIFICATION_METHOD');
  }
  if (typeof input.ownerId !== 'string' || !UUID.test(input.ownerId)) {
    throw new IssuerProfileError('INVALID_OWNER_ID');
  }
  if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new IssuerProfileError('INVALID_SESSION', 401);
  }
  if (!Array.isArray(input.addressLines) ||
      input.addressLines.length < 1 || input.addressLines.length > 3) {
    throw new IssuerProfileError('INVALID_ADDRESS_LINES');
  }
  const addressLines = input.addressLines.map(line =>
    safeText(line, 200, 'INVALID_ADDRESS_LINE'));
  const countryCode = safeText(input.countryCode, 2, 'INVALID_COUNTRY_CODE').toUpperCase();
  if (!COUNTRY.test(countryCode)) throw new IssuerProfileError('INVALID_COUNTRY_CODE');
  const contactEmail = safeText(input.contactEmail, 254, 'INVALID_CONTACT_EMAIL', { required: false });
  if (contactEmail && !EMAIL.test(contactEmail)) {
    throw new IssuerProfileError('INVALID_CONTACT_EMAIL');
  }
  const contactPhone = safeText(input.contactPhone, 40, 'INVALID_CONTACT_PHONE', { required: false });

  return Object.freeze({
    legalName: safeText(input.legalName, 200, 'INVALID_LEGAL_NAME'),
    displayName: safeText(input.displayName, 200, 'INVALID_DISPLAY_NAME'),
    addressLines: Object.freeze(addressLines),
    city: safeText(input.city, 120, 'INVALID_CITY'),
    region: safeText(input.region, 120, 'INVALID_REGION'),
    postalCode: safeText(input.postalCode, 32, 'INVALID_POSTAL_CODE'),
    countryCode,
    contactEmail: contactEmail ? contactEmail.toLowerCase() : null,
    contactPhone,
    taxRegistrations: normalizeTaxRegistrations(input.taxRegistrations),
    verificationMethod: METHOD,
    verificationReference: safeText(
      input.verificationReference, 200, 'INVALID_VERIFICATION_REFERENCE'
    ),
    ownerId: input.ownerId.toLowerCase(),
    sessionToken: input.sessionToken,
  });
}

function canonicalProfile(fields) {
  return {
    legalName: fields.legalName,
    displayName: fields.displayName,
    addressLines: [...fields.addressLines],
    city: fields.city,
    region: fields.region,
    postalCode: fields.postalCode,
    countryCode: fields.countryCode,
    contactEmail: fields.contactEmail,
    contactPhone: fields.contactPhone,
    taxRegistrations: fields.taxRegistrations.map(item => ({
      scheme: item.scheme,
      registrationNumber: item.registrationNumber,
    })),
  };
}

function profileHash(fields) {
  return crypto.createHash('sha256')
    .update('facturations-issuer-profile-v1\0')
    .update(JSON.stringify(canonicalProfile(fields)))
    .digest('hex');
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    version: row.profile_version,
    legalName: row.legal_name,
    displayName: row.display_name,
    addressLines: Object.freeze([...row.address_lines]),
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    contactEmail: row.contact_email || null,
    contactPhone: row.contact_phone || null,
    taxRegistrations: Object.freeze(row.tax_registrations.map(item => Object.freeze({
      scheme: item.scheme,
      registrationNumber: item.registrationNumber,
    }))),
    profileHash: row.profile_hash,
    verificationMethod: row.verification_method,
    verificationReference: row.verification_reference,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at,
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  });
}

function createIssuerProfileStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getLatest() {
    const found = await pool.query(
      `SELECT * FROM facturations_issuer_profiles
        WHERE business_id=$1 AND state='VERIFIED'
        ORDER BY profile_version DESC LIMIT 1`,
      [tenant]
    );
    if (!found.rows.length) throw new IssuerProfileError('ISSUER_PROFILE_NOT_FOUND', 404);
    return resultOf(found.rows[0]);
  }

  async function getById(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'profileId' ||
        typeof input.profileId !== 'string' || !UUID.test(input.profileId)) {
      throw new IssuerProfileError('INVALID_PROFILE_LOOKUP');
    }
    const found = await pool.query(
      'SELECT * FROM facturations_issuer_profiles WHERE business_id=$1 AND id=$2',
      [tenant, input.profileId.toLowerCase()]
    );
    if (!found.rows.length) throw new IssuerProfileError('ISSUER_PROFILE_NOT_FOUND', 404);
    return resultOf(found.rows[0]);
  }

  async function createVerified(input) {
    const fields = normalizeInput(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    const hash = profileHash(fields);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenant]);

      const owner = await client.query(
        `SELECT u.id
           FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u
             ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`,
        [tenant, fields.ownerId, digest]
      );
      if (!owner.rows.length) throw new IssuerProfileError('OWNER_AUTH_REQUIRED', 403);

      const existing = await client.query(
        'SELECT * FROM facturations_issuer_profiles WHERE business_id=$1 AND profile_hash=$2',
        [tenant, hash]
      );
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.verified_by !== fields.ownerId ||
            row.verification_method !== fields.verificationMethod ||
            row.verification_reference !== fields.verificationReference) {
          throw new IssuerProfileError('PROFILE_ALREADY_VERIFIED_DIFFERENT_EVIDENCE', 409);
        }
        await client.query('COMMIT');
        transaction = false;
        return resultOf(row);
      }

      const versionResult = await client.query(
        'SELECT COALESCE(MAX(profile_version),0)::integer + 1 AS next_version FROM facturations_issuer_profiles WHERE business_id=$1',
        [tenant]
      );
      const nextVersion = versionResult.rows[0].next_version;
      const profile = canonicalProfile(fields);
      const inserted = await client.query(
        `INSERT INTO facturations_issuer_profiles
           (business_id,profile_version,legal_name,display_name,address_lines,city,region,
            postal_code,country_code,contact_email,contact_phone,tax_registrations,profile_hash,
            verification_method,verification_reference,verified_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
         RETURNING *`,
        [
          tenant, nextVersion, profile.legalName, profile.displayName,
          JSON.stringify(profile.addressLines), profile.city, profile.region,
          profile.postalCode, profile.countryCode, profile.contactEmail,
          profile.contactPhone, JSON.stringify(profile.taxRegistrations), hash,
          fields.verificationMethod, fields.verificationReference, fields.ownerId,
        ]
      );

      await client.query('COMMIT');
      transaction = false;
      return resultOf(inserted.rows[0]);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ createVerified, getLatest, getById });
}

module.exports = {
  createIssuerProfileStore,
  IssuerProfileError,
  normalizeIssuerProfile: normalizeInput,
};
