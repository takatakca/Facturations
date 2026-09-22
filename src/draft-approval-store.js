'use strict';

const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

class DraftApprovalError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'DraftApprovalError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateApproval(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'confirmation,draftId,expectedCustomerEmail,expectedTotalCents,ownerId,sessionToken') {
    throw new DraftApprovalError('INVALID_APPROVAL');
  }
  const { confirmation, draftId, ownerId, sessionToken, expectedTotalCents, expectedCustomerEmail } = input;
  if (confirmation !== 'APPROVE_DRAFT_ONLY') throw new DraftApprovalError('CONFIRMATION_REQUIRED');
  if (typeof draftId !== 'string' || !UUID.test(draftId)) throw new DraftApprovalError('INVALID_DRAFT_ID');
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new DraftApprovalError('INVALID_OWNER_ID');
  if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) {
    throw new DraftApprovalError('INVALID_SESSION', 401);
  }
  if (!Number.isSafeInteger(expectedTotalCents) || expectedTotalCents < 0 || expectedTotalCents > 1_000_000_000_000) {
    throw new DraftApprovalError('INVALID_EXPECTED_TOTAL');
  }
  if (typeof expectedCustomerEmail !== 'string' || expectedCustomerEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(expectedCustomerEmail) ||
      /[\u0000-\u001f\u007f]/u.test(expectedCustomerEmail)) {
    throw new DraftApprovalError('INVALID_EXPECTED_RECIPIENT');
  }
  return { confirmation, draftId, ownerId, sessionToken, expectedTotalCents,
    expectedCustomerEmail: expectedCustomerEmail.toLowerCase() };
}

function validateApprovalRead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'draftId,ownerId,sessionToken') {
    throw new DraftApprovalError('INVALID_APPROVAL_LOOKUP');
  }
  if (typeof input.draftId !== 'string' || !UUID.test(input.draftId) ||
      typeof input.ownerId !== 'string' || !UUID.test(input.ownerId)) {
    throw new DraftApprovalError('INVALID_APPROVAL_LOOKUP');
  }
  if (typeof input.sessionToken !== 'string' || !TOKEN.test(input.sessionToken)) {
    throw new DraftApprovalError('INVALID_SESSION', 401);
  }
  return input;
}

function asResult(row) {
  return Object.freeze({ id: row.id, draftId: row.draft_id,
    status: 'APPROVED_INTERNAL_ONLY', approvedBy: row.approved_by,
    approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : row.approved_at,
    issued: false, waveSynced: false, emailed: false });
}

function createDraftApprovalStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  // Read-only persisted status, with a fresh OWNER session and a real draft in
  // the exact tenant. A UUID by itself never authorizes disclosure.
  async function isApproved(input) {
    const fields = validateApprovalRead(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    let result;
    try {
      result = await pool.query(
        `SELECT a.id AS approval_id FROM facturations_staff_sessions s
           JOIN facturations_staff_users u
             ON u.business_id=s.business_id AND u.id=s.user_id
           JOIN invoice_drafts d
             ON d.business_id=s.business_id AND d.id=$4 AND d.status='DRAFT'
           LEFT JOIN facturations_draft_approvals a
             ON a.business_id=d.business_id AND a.draft_id=d.id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'`,
        [tenant, fields.ownerId, digest, fields.draftId]
      );
    } catch {
      throw new DraftApprovalError('STORAGE_UNAVAILABLE', 503);
    }
    if (result.rows.length !== 1) throw new DraftApprovalError('APPROVAL_UNAVAILABLE', 403);
    return result.rows[0].approval_id !== null;
  }

  // Trusted backend operation exposed only through the independently protected
  // OWNER, Origin and CSRF browser route. An approval is INTERNAL ONLY, never
  // permission to issue an invoice, sync Wave, send email or take payment.
  async function approveDraft(input) {
    const fields = validateApproval(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      // Lock the owner and session so revocation cannot race this decision.
      const owner = await client.query(
        `SELECT u.id FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`,
        [tenant, fields.ownerId, digest]
      );
      if (!owner.rows.length) throw new DraftApprovalError('OWNER_AUTH_REQUIRED', 403);
      const found = await client.query(
        `SELECT id,request_hash,snapshot FROM invoice_drafts
          WHERE business_id=$1 AND id=$2 AND status='DRAFT' FOR SHARE`,
        [tenant, fields.draftId]
      );
      if (!found.rows.length) throw new DraftApprovalError('DRAFT_NOT_FOUND', 404);
      const draft = found.rows[0];
      if (draft.snapshot?.totalCents !== fields.expectedTotalCents ||
          typeof draft.snapshot?.customer?.email !== 'string' ||
          draft.snapshot.customer.email.toLowerCase() !== fields.expectedCustomerEmail) {
        throw new DraftApprovalError('APPROVAL_DETAILS_CHANGED', 409);
      }
      const inserted = await client.query(
        `INSERT INTO facturations_draft_approvals (business_id,draft_id,approved_by,request_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id,draft_id) DO NOTHING
         RETURNING id,draft_id,approved_by,request_hash,approved_at`,
        [tenant, fields.draftId, fields.ownerId, draft.request_hash]
      );
      let record = inserted.rows[0];
      if (!record) {
        const prior = await client.query(
          `SELECT id,draft_id,approved_by,request_hash,approved_at
             FROM facturations_draft_approvals WHERE business_id=$1 AND draft_id=$2`,
          [tenant, fields.draftId]
        );
        record = prior.rows[0];
        if (!record || record.approved_by !== fields.ownerId || record.request_hash !== draft.request_hash) {
          throw new DraftApprovalError('ALREADY_APPROVED', 409);
        }
      }
      await client.query('COMMIT');
      inTransaction = false;
      return asResult(record);
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ approveDraft, isApproved });
}

module.exports = { createDraftApprovalStore, DraftApprovalError, validateApproval };
