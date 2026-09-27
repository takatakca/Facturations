'use strict';

const crypto = require('node:crypto');
const { previewDraft, DraftValidationError } = require('./draft-preview');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

class SubmissionError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'SubmissionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
      'confirmation,expectedCustomerEmail,expectedRevision,expectedTotalCents,sessionToken,workspaceId') {
    throw new SubmissionError('INVALID_SUBMISSION');
  }
  const { confirmation, expectedCustomerEmail, expectedRevision, expectedTotalCents, sessionToken, workspaceId } = input;
  if (confirmation !== 'CREATE_IMMUTABLE_DRAFT_ONLY') throw new SubmissionError('CONFIRMATION_REQUIRED');
  if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) throw new SubmissionError('UNAUTHORIZED', 401);
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) throw new SubmissionError('INVALID_WORKSPACE_ID');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2147483647) {
    throw new SubmissionError('INVALID_REVISION');
  }
  if (!Number.isSafeInteger(expectedTotalCents) || expectedTotalCents < 0 || expectedTotalCents > 1_000_000_000_000) {
    throw new SubmissionError('INVALID_TOTAL');
  }
  if (typeof expectedCustomerEmail !== 'string' || expectedCustomerEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(expectedCustomerEmail) ||
      /[\u0000-\u001f\u007f]/u.test(expectedCustomerEmail)) {
    throw new SubmissionError('INVALID_RECIPIENT');
  }
  return { confirmation, expectedCustomerEmail: expectedCustomerEmail.toLowerCase(),
    expectedRevision, expectedTotalCents, sessionToken, workspaceId };
}

function createWorkspaceSubmissionStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  // Browser calls this only via an independently protected OWNER, Origin and CSRF handler.
  // All changes, including the source link, customer and audit event, commit atomically.
  async function submit(input) {
    const fields = validateSubmission(input);
    const digest = crypto.createHash('sha256').update(fields.sessionToken, 'utf8').digest();
    let client, inTransaction = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;
      const active = await client.query(
        `SELECT u.id FROM facturations_staff_sessions s
           JOIN facturations_staff_users u ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
            AND s.expires_at > now() AND u.enabled AND u.email_verified_at IS NOT NULL
            AND u.role='OWNER' FOR SHARE OF s,u`, [tenant, digest]
      );
      if (active.rows.length !== 1) throw new SubmissionError('OWNER_AUTH_REQUIRED', 403);
      const ownerId = active.rows[0].id;
      const found = await client.query(
        `SELECT id,revision,content FROM facturations_draft_workspaces
          WHERE business_id=$1 AND owner_staff_id=$2 AND id=$3 FOR UPDATE`,
        [tenant, ownerId, fields.workspaceId]
      );
      if (!found.rows.length) throw new SubmissionError('WORKSPACE_NOT_FOUND', 404);
      const workspace = found.rows[0];
      if (workspace.revision !== fields.expectedRevision) throw new SubmissionError('REVISION_CHANGED', 409);
      // The saved server revision, NEVER a client-supplied amount/snapshot, is the source of truth.
      const preview = previewDraft(workspace.content);
      if (preview.totalCents !== fields.expectedTotalCents ||
          preview.customer.email.toLowerCase() !== fields.expectedCustomerEmail) {
        throw new SubmissionError('DETAILS_CHANGED', 409);
      }
      const prior = await client.query(
        `SELECT draft_id,revision FROM facturations_workspace_submissions
          WHERE business_id=$1 AND workspace_id=$2`, [tenant, workspace.id]
      );
      if (prior.rows.length) {
        if (prior.rows[0].revision !== fields.expectedRevision) throw new SubmissionError('ALREADY_SUBMITTED', 409);
        await client.query('COMMIT');
        inTransaction = false;
        return Object.freeze({ draftId: prior.rows[0].draft_id, revision: workspace.revision,
          status: 'DRAFT', created: false, issued: false, waveSynced: false, emailed: false });
      }
      const normalizedEmail = preview.customer.email.toLowerCase();
      await client.query(
        `INSERT INTO invoice_customers (business_id,name,email,email_normalized,address)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id,email_normalized) DO NOTHING`,
        [tenant, preview.customer.name, preview.customer.email, normalizedEmail, preview.customer.address]
      );
      const customer = await client.query(
        'SELECT id FROM invoice_customers WHERE business_id=$1 AND email_normalized=$2',
        [tenant, normalizedEmail]
      );
      if (customer.rows.length !== 1) throw new SubmissionError('STORAGE_UNAVAILABLE', 503);
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex');
      const snapshot = { ...preview, status: 'DRAFT', persisted: true };
      const draft = await client.query(
        `INSERT INTO invoice_drafts (business_id,customer_id,idempotency_key,request_hash,snapshot)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [tenant, customer.rows[0].id, 'workspace_' + workspace.id.replace(/-/g, ''),
          requestHash, JSON.stringify(snapshot)]
      );
      const draftId = draft.rows[0].id;
      await client.query(
        "INSERT INTO invoice_audit_events (business_id,draft_id,action) VALUES ($1,$2,'DRAFT_CREATED')",
        [tenant, draftId]
      );
      await client.query(
        `INSERT INTO facturations_workspace_submissions
           (business_id,workspace_id,revision,draft_id,submitted_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant, workspace.id, workspace.revision, draftId, ownerId]
      );
      await client.query('COMMIT');
      inTransaction = false;
      return Object.freeze({ draftId, revision: workspace.revision,
        status: 'DRAFT', created: true, issued: false, waveSynced: false, emailed: false });
    } catch (error) {
      if (client && inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      }
      if (error instanceof SubmissionError || error instanceof DraftValidationError) throw error;
      throw new SubmissionError('STORAGE_UNAVAILABLE', 503);
    } finally {
      if (client) client.release();
    }
  }
  return Object.freeze({ submit });
}

module.exports = { createWorkspaceSubmissionStore, SubmissionError, validateSubmission };
