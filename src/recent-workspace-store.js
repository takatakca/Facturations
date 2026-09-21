'use strict';

const crypto = require('node:crypto');
const { WorkspaceError } = require('./draft-workspace-store');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LIMIT = 20;

// Read-only, bounded listing. Authorization and owner/tenant filtering happen in
// the SAME SQL statement, so an invalid session cannot enumerate any records.
function createRecentWorkspaceStore({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function' || typeof businessId !== 'string' ||
      !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated PostgreSQL pool and business ID required');
  }
  const tenant = businessId.trim();

  async function list({ token }) {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new WorkspaceError('UNAUTHORIZED', 401);
    }
    const digest = crypto.createHash('sha256').update(token).digest();
    let result;
    try {
      result = await pool.query(
        `WITH active_staff AS MATERIALIZED (
           SELECT u.id
             FROM facturations_staff_sessions s
             JOIN facturations_staff_users u
               ON u.business_id=s.business_id AND u.id=s.user_id
            WHERE s.business_id=$1 AND s.token_hash=$2
              AND s.revoked_at IS NULL AND s.expires_at > now()
              AND u.enabled AND u.email_verified_at IS NOT NULL
              AND u.role IN ('OWNER','STAFF')
            LIMIT 1
         )
         SELECT active_staff.id AS authorized_staff_id,
                w.id,w.revision,w.updated_at,
                left(w.content #>> '{customer,name}',160) AS customer_name
           FROM active_staff
           LEFT JOIN LATERAL (
             SELECT id,revision,updated_at,content
               FROM facturations_draft_workspaces
              WHERE business_id=$1 AND owner_staff_id=active_staff.id
              ORDER BY updated_at DESC,id DESC LIMIT 20
           ) w ON TRUE
          ORDER BY w.updated_at DESC NULLS LAST,w.id DESC NULLS LAST`,
        [tenant, digest]
      );
    } catch {
      throw new WorkspaceError('STORAGE_UNAVAILABLE', 503);
    }
    if (!result.rows.length) throw new WorkspaceError('UNAUTHORIZED', 401);
    return {
      status: 'WORKSPACES_ONLY',
      workspaces: result.rows.filter(row => row.id !== null).map(row => ({
        id: row.id,
        revision: row.revision,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        customerName: typeof row.customer_name === 'string' ? row.customer_name : null,
      })),
    };
  }

  return Object.freeze({ list });
}

module.exports = { createRecentWorkspaceStore, LIMIT };
