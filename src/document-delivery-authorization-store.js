'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONFIRMATION = 'AUTHORIZE_EMAIL_DELIVERY';

class DocumentDeliveryAuthorizationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'DocumentDeliveryAuthorizationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new DocumentDeliveryAuthorizationError(code);
  }
  return value.toLowerCase();
}

function safeText(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DocumentDeliveryAuthorizationError(code);
  }
  return value.trim();
}

function email(value) {
  const result = safeText(value, 254, 'INVALID_RECIPIENT_EMAIL').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) {
    throw new DocumentDeliveryAuthorizationError('INVALID_RECIPIENT_EMAIL');
  }
  return result;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new DocumentDeliveryAuthorizationError(code);
  }
  return value;
}

function validateRequest(input) {
  const expected = [
    'channel','confirmation','documentId','expectedContentSha256',
    'expectedIssuerProfileHash','expectedOfficialInvoiceNumber',
    'expectedRecipientEmail','ownerId','sessionToken',
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== expected.sort().join(',')) {
    throw new DocumentDeliveryAuthorizationError('INVALID_DELIVERY_AUTHORIZATION');
  }
  if (input.confirmation !== CONFIRMATION) {
    throw new DocumentDeliveryAuthorizationError('DELIVERY_CONFIRMATION_REQUIRED');
  }
  if (input.channel !== 'EMAIL') {
    throw new DocumentDeliveryAuthorizationError('INVALID_DELIVERY_CHANNEL');
  }
  if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new DocumentDeliveryAuthorizationError('INVALID_SESSION', 401);
  }
  return Object.freeze({
    documentId: uuid(input.documentId, 'INVALID_DOCUMENT_ID'),
    ownerId: uuid(input.ownerId, 'INVALID_OWNER_ID'),
    sessionToken: input.sessionToken,
    channel: input.channel,
    recipientEmail: email(input.expectedRecipientEmail),
    officialInvoiceNumber: safeText(
      input.expectedOfficialInvoiceNumber, 160, 'INVALID_OFFICIAL_INVOICE_NUMBER'
    ),
    contentSha256: sha256(input.expectedContentSha256, 'INVALID_DOCUMENT_SHA256'),
    issuerProfileHash: sha256(input.expectedIssuerProfileHash, 'INVALID_ISSUER_PROFILE_HASH'),
  });
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    documentId: row.document_id,
    issuedInvoiceId: row.issued_invoice_id,
    channel: row.delivery_channel,
    recipientEmail: row.recipient_email,
    officialInvoiceNumber: row.official_invoice_number,
    documentSha256: row.document_sha256,
    issuerProfileVersionId: row.issuer_profile_version_id,
    issuerProfileHash: row.issuer_profile_hash,
    state: row.state,
    authorizedBy: row.authorized_by,
    authorizedAt: row.authorized_at instanceof Date
      ? row.authorized_at.toISOString() : row.authorized_at,
    deliveryAuthorized: true,
    sent: false,
    emailed: false,
  });
}

async function requireOwner(client, tenant, ownerId, sessionToken) {
  const digest = crypto.createHash('sha256').update(sessionToken, 'utf8').digest();
  const found = await client.query(
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
  if (!found.rows.length) {
    throw new DocumentDeliveryAuthorizationError('OWNER_AUTH_REQUIRED', 403);
  }
}

function createDocumentDeliveryAuthorizationStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function authorize(input) {
    const fields = validateRequest(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      await requireOwner(client, tenant, fields.ownerId, fields.sessionToken);

      const chainResult = await client.query(
        `SELECT
            d.id AS document_id,d.issued_invoice_id,d.content_sha256,
            d.delivery_state AS document_delivery_state,
            i.official_invoice_number,i.issued_snapshot,i.status AS invoice_status,
            i.delivery_state AS invoice_delivery_state,
            b.issuer_profile_version_id,b.issuer_profile_hash,
            p.profile_hash AS stored_profile_hash,
            v.id AS verification_id
           FROM facturations_issued_invoice_documents AS d
           JOIN facturations_issued_invoices AS i
             ON i.business_id=d.business_id AND i.id=d.issued_invoice_id
           JOIN facturations_issued_invoice_document_issuer_bindings AS b
             ON b.business_id=d.business_id AND b.document_id=d.id
           JOIN facturations_issuer_profile_versions AS p
             ON p.business_id=b.business_id AND p.id=b.issuer_profile_version_id
           JOIN facturations_issuer_profile_verifications AS v
             ON v.business_id=p.business_id AND v.profile_version_id=p.id
          WHERE d.business_id=$1 AND d.id=$2
          FOR SHARE OF d,i,b,p,v`,
        [tenant, fields.documentId]
      );
      if (!chainResult.rows.length) {
        throw new DocumentDeliveryAuthorizationError('DELIVERABLE_DOCUMENT_NOT_FOUND', 404);
      }
      const chain = chainResult.rows[0];
      const snapshotEmail = chain.issued_snapshot?.customer?.email;
      if (chain.invoice_status !== 'ISSUED_CONFIRMED' ||
          chain.invoice_delivery_state !== 'NOT_AUTHORIZED' ||
          chain.document_delivery_state !== 'NOT_AUTHORIZED' ||
          !chain.verification_id ||
          chain.issuer_profile_hash !== chain.stored_profile_hash) {
        throw new DocumentDeliveryAuthorizationError('DELIVERY_CHAIN_NOT_READY', 409);
      }
      if (typeof snapshotEmail !== 'string' ||
          snapshotEmail.toLowerCase() !== fields.recipientEmail ||
          chain.official_invoice_number !== fields.officialInvoiceNumber ||
          chain.content_sha256 !== fields.contentSha256 ||
          chain.issuer_profile_hash !== fields.issuerProfileHash) {
        throw new DocumentDeliveryAuthorizationError('DELIVERY_CONFIRMATION_MISMATCH', 409);
      }

      const inserted = await client.query(
        `INSERT INTO facturations_document_delivery_authorizations
           (business_id,document_id,issued_invoice_id,delivery_channel,recipient_email,
            official_invoice_number,document_sha256,issuer_profile_version_id,
            issuer_profile_hash,authorized_by,confirmation)
         VALUES ($1,$2,$3,'EMAIL',$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (business_id,document_id) DO NOTHING
         RETURNING *`,
        [
          tenant,
          chain.document_id,
          chain.issued_invoice_id,
          fields.recipientEmail,
          fields.officialInvoiceNumber,
          fields.contentSha256,
          chain.issuer_profile_version_id,
          fields.issuerProfileHash,
          fields.ownerId,
          CONFIRMATION,
        ]
      );

      let row = inserted.rows[0];
      if (!row) {
        const prior = await client.query(
          `SELECT * FROM facturations_document_delivery_authorizations
            WHERE business_id=$1 AND document_id=$2`,
          [tenant, fields.documentId]
        );
        row = prior.rows[0];
        if (!row ||
            row.issued_invoice_id !== chain.issued_invoice_id ||
            row.delivery_channel !== 'EMAIL' ||
            row.recipient_email !== fields.recipientEmail ||
            row.official_invoice_number !== fields.officialInvoiceNumber ||
            row.document_sha256 !== fields.contentSha256 ||
            row.issuer_profile_version_id !== chain.issuer_profile_version_id ||
            row.issuer_profile_hash !== fields.issuerProfileHash ||
            row.state !== 'AUTHORIZED_NOT_SENT') {
          throw new DocumentDeliveryAuthorizationError('DELIVERY_AUTHORIZATION_CONFLICT', 409);
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

  async function getByDocument(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'documentId') {
      throw new DocumentDeliveryAuthorizationError('INVALID_DELIVERY_AUTHORIZATION_LOOKUP');
    }
    const documentId = uuid(input.documentId, 'INVALID_DOCUMENT_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_document_delivery_authorizations
        WHERE business_id=$1 AND document_id=$2`,
      [tenant, documentId]
    );
    if (!found.rows.length) {
      throw new DocumentDeliveryAuthorizationError('DELIVERY_AUTHORIZATION_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  return Object.freeze({ authorize, getByDocument });
}

module.exports = {
  createDocumentDeliveryAuthorizationStore,
  DocumentDeliveryAuthorizationError,
  DOCUMENT_DELIVERY_CONFIRMATION: CONFIRMATION,
};
