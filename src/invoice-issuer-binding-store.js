'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONFIRMATION = 'BIND_VERIFIED_ISSUER_TO_INVOICE';

class InvoiceIssuerBindingError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'InvoiceIssuerBindingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvoiceIssuerBindingError(code);
  }
  return value.toLowerCase();
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'confirmation,issuedInvoiceId,issuerProfileId,ownerId,sessionToken') {
    throw new InvoiceIssuerBindingError('INVALID_ISSUER_BINDING_REQUEST');
  }
  if (input.confirmation !== CONFIRMATION) {
    throw new InvoiceIssuerBindingError('ISSUER_BINDING_CONFIRMATION_REQUIRED');
  }
  if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new InvoiceIssuerBindingError('INVALID_SESSION', 401);
  }
  return Object.freeze({
    issuedInvoiceId: uuid(input.issuedInvoiceId, 'INVALID_ISSUED_INVOICE_ID'),
    issuerProfileId: uuid(input.issuerProfileId, 'INVALID_ISSUER_PROFILE_ID'),
    ownerId: uuid(input.ownerId, 'INVALID_OWNER_ID'),
    sessionToken: input.sessionToken,
    confirmation: CONFIRMATION,
  });
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    issuedInvoiceId: row.issued_invoice_id,
    issuerProfileId: row.issuer_profile_id,
    issuerProfileHash: row.issuer_profile_hash,
    issuerProfileVersion: row.issuer_profile_version,
    boundBy: row.bound_by,
    confirmation: row.confirmation,
    boundAt: row.bound_at instanceof Date ? row.bound_at.toISOString() : row.bound_at,
  });
}

function createInvoiceIssuerBindingStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getByIssuedInvoice(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'issuedInvoiceId') {
      throw new InvoiceIssuerBindingError('INVALID_ISSUER_BINDING_LOOKUP');
    }
    const issuedInvoiceId = uuid(input.issuedInvoiceId, 'INVALID_ISSUED_INVOICE_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_invoice_issuer_bindings
        WHERE business_id=$1 AND issued_invoice_id=$2`,
      [tenant, issuedInvoiceId]
    );
    if (!found.rows.length) {
      throw new InvoiceIssuerBindingError('ISSUER_BINDING_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  async function bind(input) {
    const fields = validateInput(input);
    const sessionHash = crypto.createHash('sha256')
      .update(fields.sessionToken, 'utf8').digest();
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const owner = await client.query(
        `SELECT u.id
           FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u
             ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`,
        [tenant, fields.ownerId, sessionHash]
      );
      if (!owner.rows.length) {
        throw new InvoiceIssuerBindingError('OWNER_AUTH_REQUIRED', 403);
      }

      const issued = await client.query(
        `SELECT id,status,delivery_state
           FROM facturations_issued_invoices
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant, fields.issuedInvoiceId]
      );
      if (!issued.rows.length) {
        throw new InvoiceIssuerBindingError('ISSUED_INVOICE_NOT_FOUND', 404);
      }
      if (issued.rows[0].status !== 'ISSUED_CONFIRMED' ||
          issued.rows[0].delivery_state !== 'NOT_AUTHORIZED') {
        throw new InvoiceIssuerBindingError('ISSUED_INVOICE_NOT_BINDABLE', 409);
      }

      const profile = await client.query(
        `SELECT id,profile_hash,profile_version,state
           FROM facturations_issuer_profiles
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant, fields.issuerProfileId]
      );
      if (!profile.rows.length) {
        throw new InvoiceIssuerBindingError('ISSUER_PROFILE_NOT_FOUND', 404);
      }
      if (profile.rows[0].state !== 'VERIFIED') {
        throw new InvoiceIssuerBindingError('VERIFIED_ISSUER_PROFILE_REQUIRED', 409);
      }

      const inserted = await client.query(
        `INSERT INTO facturations_invoice_issuer_bindings
           (business_id,issued_invoice_id,issuer_profile_id,issuer_profile_hash,
            issuer_profile_version,bound_by,confirmation)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (business_id,issued_invoice_id) DO NOTHING
         RETURNING *`,
        [
          tenant,
          fields.issuedInvoiceId,
          fields.issuerProfileId,
          profile.rows[0].profile_hash,
          profile.rows[0].profile_version,
          fields.ownerId,
          fields.confirmation,
        ]
      );

      let row = inserted.rows[0];
      if (!row) {
        const prior = await client.query(
          `SELECT * FROM facturations_invoice_issuer_bindings
            WHERE business_id=$1 AND issued_invoice_id=$2`,
          [tenant, fields.issuedInvoiceId]
        );
        row = prior.rows[0];
        if (!row ||
            row.issuer_profile_id !== fields.issuerProfileId ||
            row.issuer_profile_hash !== profile.rows[0].profile_hash ||
            Number(row.issuer_profile_version) !== Number(profile.rows[0].profile_version) ||
            row.bound_by !== fields.ownerId ||
            row.confirmation !== fields.confirmation) {
          throw new InvoiceIssuerBindingError('ISSUER_BINDING_CONFLICT', 409);
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

  return Object.freeze({ bind, getByIssuedInvoice });
}

module.exports = {
  createInvoiceIssuerBindingStore,
  InvoiceIssuerBindingError,
};
