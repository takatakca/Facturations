'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CONFIRMATION = 'AUTHORIZE_QUALIFIED_PDF_DELIVERY';

class DeliveryAuthorizationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'DeliveryAuthorizationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DeliveryAuthorizationError(code);
  return value.toLowerCase();
}

function email(value) {
  if (typeof value !== 'string') throw new DeliveryAuthorizationError('INVALID_RECIPIENT_EMAIL');
  const normalized = value.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 254) {
    throw new DeliveryAuthorizationError('INVALID_RECIPIENT_EMAIL');
  }
  return normalized;
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    issuedInvoiceId: row.issued_invoice_id,
    qualifiedDocumentId: row.qualified_document_id,
    qualifiedDocumentSha256: row.qualified_document_sha256,
    expectedRecipientEmail: row.expected_recipient_email,
    recipientSnapshotHash: row.recipient_snapshot_hash,
    authorizedBy: row.authorized_by,
    confirmation: row.confirmation,
    state: row.state,
    authorizedAt: row.authorized_at instanceof Date ? row.authorized_at.toISOString() : row.authorized_at,
    deliveryPerformed: false,
    emailed: false,
  });
}

function createDeliveryAuthorizationStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getByQualifiedDocument(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'qualifiedDocumentId') {
      throw new DeliveryAuthorizationError('INVALID_DELIVERY_AUTHORIZATION_LOOKUP');
    }
    const qualifiedDocumentId = uuid(input.qualifiedDocumentId, 'INVALID_QUALIFIED_DOCUMENT_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_delivery_authorizations
        WHERE business_id=$1 AND qualified_document_id=$2`,
      [tenant, qualifiedDocumentId]
    );
    if (!found.rows.length) throw new DeliveryAuthorizationError('DELIVERY_AUTHORIZATION_NOT_FOUND', 404);
    return resultOf(found.rows[0]);
  }

  async function authorize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'confirmation,expectedRecipientEmail,ownerId,qualifiedDocumentId,sessionToken') {
      throw new DeliveryAuthorizationError('INVALID_DELIVERY_AUTHORIZATION');
    }
    if (input.confirmation !== CONFIRMATION) {
      throw new DeliveryAuthorizationError('DELIVERY_CONFIRMATION_REQUIRED');
    }
    if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
      throw new DeliveryAuthorizationError('INVALID_SESSION', 401);
    }

    const qualifiedDocumentId = uuid(input.qualifiedDocumentId, 'INVALID_QUALIFIED_DOCUMENT_ID');
    const ownerId = uuid(input.ownerId, 'INVALID_OWNER_ID');
    const expectedRecipientEmail = email(input.expectedRecipientEmail);
    const sessionHash = crypto.createHash('sha256').update(input.sessionToken, 'utf8').digest();

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
        [tenant, ownerId, sessionHash]
      );
      if (!owner.rows.length) throw new DeliveryAuthorizationError('OWNER_AUTH_REQUIRED', 403);

      const chain = await client.query(
        `SELECT q.id AS qualified_document_id,q.issued_invoice_id,q.content_sha256,
                q.delivery_state AS qualified_delivery_state,
                i.status AS invoice_status,i.delivery_state AS invoice_delivery_state,
                i.issued_snapshot
           FROM facturations_qualified_invoice_documents AS q
           JOIN facturations_issued_invoices AS i
             ON i.business_id=q.business_id AND i.id=q.issued_invoice_id
          WHERE q.business_id=$1 AND q.id=$2
          FOR SHARE OF q,i`,
        [tenant, qualifiedDocumentId]
      );
      if (!chain.rows.length) throw new DeliveryAuthorizationError('QUALIFIED_DOCUMENT_NOT_FOUND', 404);
      const row = chain.rows[0];

      if (row.invoice_status !== 'ISSUED_CONFIRMED' ||
          row.invoice_delivery_state !== 'NOT_AUTHORIZED' ||
          row.qualified_delivery_state !== 'NOT_AUTHORIZED') {
        throw new DeliveryAuthorizationError('DELIVERY_SOURCE_NOT_READY', 409);
      }
      const actualRecipient = row.issued_snapshot?.customer?.email;
      if (typeof actualRecipient !== 'string' ||
          actualRecipient.trim().toLowerCase() !== expectedRecipientEmail) {
        throw new DeliveryAuthorizationError('RECIPIENT_MISMATCH', 409);
      }

      const recipientSnapshotHash = crypto.createHash('sha256')
        .update('facturations-delivery-recipient-v1\0')
        .update(JSON.stringify({
          email: expectedRecipientEmail,
          customerName: row.issued_snapshot?.customer?.name ?? null,
          qualifiedDocumentId,
          qualifiedDocumentSha256: row.content_sha256,
        }))
        .digest('hex');

      const inserted = await client.query(
        `INSERT INTO facturations_delivery_authorizations
           (business_id,issued_invoice_id,qualified_document_id,qualified_document_sha256,
            expected_recipient_email,recipient_snapshot_hash,authorized_by,confirmation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          tenant,
          row.issued_invoice_id,
          qualifiedDocumentId,
          row.content_sha256,
          expectedRecipientEmail,
          recipientSnapshotHash,
          ownerId,
          CONFIRMATION,
        ]
      );

      let saved = inserted.rows[0];
      if (!saved) {
        const prior = await client.query(
          `SELECT * FROM facturations_delivery_authorizations
            WHERE business_id=$1 AND qualified_document_id=$2`,
          [tenant, qualifiedDocumentId]
        );
        saved = prior.rows[0];
        if (!saved ||
            saved.issued_invoice_id !== row.issued_invoice_id ||
            saved.qualified_document_sha256 !== row.content_sha256 ||
            saved.expected_recipient_email !== expectedRecipientEmail ||
            saved.recipient_snapshot_hash !== recipientSnapshotHash ||
            saved.authorized_by !== ownerId ||
            saved.confirmation !== CONFIRMATION ||
            saved.state !== 'AUTHORIZED_PENDING_DELIVERY') {
          throw new DeliveryAuthorizationError('DELIVERY_AUTHORIZATION_CONFLICT', 409);
        }
      }

      await client.query('COMMIT');
      transaction = false;
      return resultOf(saved);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ authorize, getByQualifiedDocument });
}

module.exports = {
  createDeliveryAuthorizationStore,
  DeliveryAuthorizationError,
};
