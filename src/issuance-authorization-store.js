'use strict';

const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER = 'WAVE';
const CONFIRMATION = 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER';

class IssuanceAuthorizationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuanceAuthorizationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'confirmation,draftId,expectedCustomerEmail,expectedTotalCents,ownerId,provider,sessionToken') {
    throw new IssuanceAuthorizationError('INVALID_AUTHORIZATION');
  }
  const { confirmation, draftId, ownerId, sessionToken, expectedTotalCents,
    expectedCustomerEmail, provider } = input;
  if (confirmation !== CONFIRMATION) {
    throw new IssuanceAuthorizationError('CONFIRMATION_REQUIRED');
  }
  if (provider !== PROVIDER) throw new IssuanceAuthorizationError('INVALID_PROVIDER');
  if (typeof draftId !== 'string' || !UUID.test(draftId)) {
    throw new IssuanceAuthorizationError('INVALID_DRAFT_ID');
  }
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) {
    throw new IssuanceAuthorizationError('INVALID_OWNER_ID');
  }
  if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) {
    throw new IssuanceAuthorizationError('INVALID_SESSION', 401);
  }
  if (!Number.isSafeInteger(expectedTotalCents) || expectedTotalCents < 0 ||
      expectedTotalCents > 1_000_000_000_000) {
    throw new IssuanceAuthorizationError('INVALID_EXPECTED_TOTAL');
  }
  if (typeof expectedCustomerEmail !== 'string' || expectedCustomerEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(expectedCustomerEmail) ||
      /[\u0000-\u001f\u007f]/u.test(expectedCustomerEmail)) {
    throw new IssuanceAuthorizationError('INVALID_EXPECTED_RECIPIENT');
  }
  return Object.freeze({ confirmation, draftId, ownerId, sessionToken, expectedTotalCents,
    expectedCustomerEmail: expectedCustomerEmail.toLowerCase(), provider });
}

function validateRead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'draftId,ownerId,sessionToken') {
    throw new IssuanceAuthorizationError('INVALID_AUTHORIZATION_LOOKUP');
  }
  if (typeof input.draftId !== 'string' || !UUID.test(input.draftId) ||
      typeof input.ownerId !== 'string' || !UUID.test(input.ownerId) ||
      typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new IssuanceAuthorizationError('INVALID_AUTHORIZATION_LOOKUP');
  }
  return input;
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    draftId: row.draft_id,
    status: 'AUTHORIZED_PENDING_PROVIDER',
    provider: row.provider,
    authorizedBy: row.authorized_by,
    authorizedAt: row.authorized_at instanceof Date ? row.authorized_at.toISOString() : row.authorized_at,
    issued: false,
    waveSynced: false,
    emailed: false,
  });
}

function createIssuanceAuthorizationStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getAuthorization(input) {
    const fields = validateRead(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    let found;
    try {
      found = await pool.query(
        `SELECT a.id,a.draft_id,a.authorized_by,a.provider,a.authorized_at
           FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u
             ON u.business_id=s.business_id AND u.id=s.user_id
           JOIN invoice_drafts AS d
             ON d.business_id=s.business_id AND d.id=$4 AND d.status='DRAFT'
           LEFT JOIN facturations_issuance_authorizations AS a
             ON a.business_id=d.business_id AND a.draft_id=d.id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'`,
        [tenant, fields.ownerId, digest, fields.draftId]
      );
    } catch {
      throw new IssuanceAuthorizationError('STORAGE_UNAVAILABLE', 503);
    }
    if (found.rows.length !== 1) throw new IssuanceAuthorizationError('OWNER_AUTH_REQUIRED', 403);
    return found.rows[0].id ? resultOf(found.rows[0]) : null;
  }

  async function authorize(input) {
    const fields = validateWrite(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const owner = await client.query(
        `SELECT u.id FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u
             ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`,
        [tenant, fields.ownerId, digest]
      );
      if (!owner.rows.length) throw new IssuanceAuthorizationError('OWNER_AUTH_REQUIRED', 403);

      const draftResult = await client.query(
        `SELECT d.id,d.request_hash,d.snapshot,
                (a.id IS NOT NULL) AS internally_approved
           FROM invoice_drafts AS d
           LEFT JOIN facturations_draft_approvals AS a
             ON a.business_id=d.business_id AND a.draft_id=d.id
          WHERE d.business_id=$1 AND d.id=$2 AND d.status='DRAFT'
          FOR SHARE OF d`,
        [tenant, fields.draftId]
      );
      if (!draftResult.rows.length) throw new IssuanceAuthorizationError('DRAFT_NOT_FOUND', 404);
      const draft = draftResult.rows[0];
      if (!draft.internally_approved) {
        throw new IssuanceAuthorizationError('INTERNAL_APPROVAL_REQUIRED', 409);
      }
      if (draft.snapshot?.totalCents !== fields.expectedTotalCents ||
          typeof draft.snapshot?.customer?.email !== 'string' ||
          draft.snapshot.customer.email.toLowerCase() !== fields.expectedCustomerEmail) {
        throw new IssuanceAuthorizationError('AUTHORIZATION_DETAILS_CHANGED', 409);
      }

      const inserted = await client.query(
        `INSERT INTO facturations_issuance_authorizations
          (business_id,draft_id,authorized_by,request_hash,expected_total_cents,
           expected_customer_email,provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (business_id,draft_id) DO NOTHING
         RETURNING id,draft_id,authorized_by,request_hash,expected_total_cents,
                   expected_customer_email,provider,authorized_at`,
        [tenant, fields.draftId, fields.ownerId, draft.request_hash, fields.expectedTotalCents,
          fields.expectedCustomerEmail, fields.provider]
      );
      let row = inserted.rows[0];
      if (!row) {
        const prior = await client.query(
          `SELECT id,draft_id,authorized_by,request_hash,expected_total_cents,
                  expected_customer_email,provider,authorized_at
             FROM facturations_issuance_authorizations
            WHERE business_id=$1 AND draft_id=$2`,
          [tenant, fields.draftId]
        );
        row = prior.rows[0];
        if (!row || row.authorized_by !== fields.ownerId ||
            row.request_hash !== draft.request_hash ||
            Number(row.expected_total_cents) !== fields.expectedTotalCents ||
            row.expected_customer_email !== fields.expectedCustomerEmail ||
            row.provider !== fields.provider) {
          throw new IssuanceAuthorizationError('ALREADY_AUTHORIZED', 409);
        }
      }
      await client.query('COMMIT');
      transaction = false;
      return resultOf(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ authorize, getAuthorization });
}

module.exports = {
  createIssuanceAuthorizationStore,
  IssuanceAuthorizationError,
  validateIssuanceAuthorization: validateWrite,
};
