'use strict';

const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{16,80}$/;
const FIELDS = new Set(['currency', 'customer', 'invoiceDate', 'dueDate', 'notes', 'lines', 'taxes']);

class WorkspaceError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = 'WorkspaceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
  }
  if (Object.keys(content).some(key => !FIELDS.has(key)) ||
      (content.currency !== undefined && content.currency !== 'CAD')) {
    throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
  }
  const ancestors = new WeakSet();
  function check(value, depth) {
    if (depth > 10) throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return;
    if (typeof value === 'string' && value.length <= 2000 && !value.includes('\u0000')) return;
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null && !Array.isArray(value)) {
      throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (value.length > 50) throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
      for (const item of value) check(item, depth + 1);
    } else {
      const keys = Object.keys(value);
      if (keys.length > 50 || keys.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key))) {
        throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422);
      }
      for (const key of keys) check(value[key], depth + 1);
    }
    ancestors.delete(value);
  }
  check(content, 0);
  let serialized;
  try { serialized = JSON.stringify(content); }
  catch { throw new WorkspaceError('INVALID_WORKSPACE_CONTENT', 422); }
  if (Buffer.byteLength(serialized, 'utf8') > 24000) {
    throw new WorkspaceError('WORKSPACE_TOO_LARGE', 413);
  }
  return serialized;
}

function toWorkspace(row) {
  return {
    id: row.id,
    revision: row.revision,
    content: row.content,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    status: 'WORK_IN_PROGRESS',
    invoiceIssued: false,
    emailed: false,
  };
}

// Private backend service. The only credential accepted is an existing, live staff
// bearer token, verified AND row-locked in the same transaction as any write.
// Do not expose these methods directly as HTTP routes or bypass CSRF/origin checks.
function createDraftWorkspaceStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function run(token, operation) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new WorkspaceError('UNAUTHORIZED', 401);
    const digest = crypto.createHash('sha256').update(token).digest();
    let client;
    let inTransaction = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      inTransaction = true;
      const active = await client.query(
        `SELECT u.id FROM facturations_staff_sessions s
           JOIN facturations_staff_users u ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
            AND s.expires_at > now() AND u.enabled AND u.email_verified_at IS NOT NULL
            AND u.role IN ('OWNER','STAFF') FOR SHARE OF s,u`,
        [tenant, digest]
      );
      if (active.rows.length !== 1) throw new WorkspaceError('UNAUTHORIZED', 401);
      const value = await operation(client, active.rows[0].id);
      await client.query('COMMIT');
      inTransaction = false;
      return value;
    } catch (error) {
      if (client && inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Keep original error internal. */ }
      }
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('STORAGE_UNAVAILABLE', 503);
    } finally {
      if (client) client.release();
    }
  }

  async function create({ token, creationKey, content }) {
    if (typeof creationKey !== 'string' || !KEY.test(creationKey)) {
      throw new WorkspaceError('INVALID_CREATION_KEY', 422);
    }
    const serialized = validContent(content);
    return run(token, async (client, staffId) => {
      const inserted = await client.query(
        `INSERT INTO facturations_draft_workspaces
           (business_id,owner_staff_id,creation_key,content)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (business_id,owner_staff_id,creation_key) DO NOTHING
         RETURNING id,revision,content,created_at,updated_at`,
        [tenant, staffId, creationKey, serialized]
      );
      if (inserted.rows.length) {
        const row = inserted.rows[0];
        await client.query(
          `INSERT INTO facturations_draft_workspace_revisions
             (business_id,workspace_id,revision,saved_by,content)
           VALUES ($1,$2,1,$3,$4::jsonb)`,
          [tenant, row.id, staffId, serialized]
        );
        return toWorkspace(row);
      }
      // A retry may arrive AFTER further edits: compare against revision 1, not current content.
      const existing = await client.query(
        `SELECT w.id,w.revision,w.content,w.created_at,w.updated_at,
                (r.content=$4::jsonb) AS same_initial_content
           FROM facturations_draft_workspaces w
           JOIN facturations_draft_workspace_revisions r
             ON r.business_id=w.business_id AND r.workspace_id=w.id AND r.revision=1
          WHERE w.business_id=$1 AND w.owner_staff_id=$2 AND w.creation_key=$3`,
        [tenant, staffId, creationKey, serialized]
      );
      if (!existing.rows.length) throw new WorkspaceError('STORAGE_UNAVAILABLE', 503);
      if (!existing.rows[0].same_initial_content) {
        throw new WorkspaceError('WORKSPACE_CREATION_CONFLICT', 409);
      }
      return toWorkspace(existing.rows[0]);
    });
  }

  async function load({ token, workspaceId }) {
    if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
      throw new WorkspaceError('INVALID_WORKSPACE_ID', 422);
    }
    return run(token, async (client, staffId) => {
      const found = await client.query(
        `SELECT id,revision,content,created_at,updated_at
           FROM facturations_draft_workspaces
          WHERE business_id=$1 AND owner_staff_id=$2 AND id=$3`,
        [tenant, staffId, workspaceId]
      );
      if (!found.rows.length) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
      return toWorkspace(found.rows[0]);
    });
  }

  async function save({ token, workspaceId, expectedRevision, content }) {
    if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
      throw new WorkspaceError('INVALID_WORKSPACE_ID', 422);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= 2147483647) {
      throw new WorkspaceError('INVALID_REVISION', 422);
    }
    const serialized = validContent(content);
    return run(token, async (client, staffId) => {
      const updated = await client.query(
        `UPDATE facturations_draft_workspaces
            SET content=$5::jsonb,revision=revision+1,updated_at=now()
          WHERE business_id=$1 AND owner_staff_id=$2 AND id=$3 AND revision=$4
          RETURNING id,revision,content,created_at,updated_at`,
        [tenant, staffId, workspaceId, expectedRevision, serialized]
      );
      if (!updated.rows.length) {
        const found = await client.query(
          `SELECT 1 FROM facturations_draft_workspaces
            WHERE business_id=$1 AND owner_staff_id=$2 AND id=$3`,
          [tenant, staffId, workspaceId]
        );
        throw new WorkspaceError(found.rows.length ? 'WORKSPACE_REVISION_CONFLICT' : 'WORKSPACE_NOT_FOUND',
          found.rows.length ? 409 : 404);
      }
      const row = updated.rows[0];
      await client.query(
        `INSERT INTO facturations_draft_workspace_revisions
           (business_id,workspace_id,revision,saved_by,content)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [tenant, workspaceId, row.revision, staffId, serialized]
      );
      return toWorkspace(row);
    });
  }

  return Object.freeze({ create, load, save });
}

module.exports = { createDraftWorkspaceStore, WorkspaceError };
