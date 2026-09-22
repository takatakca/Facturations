'use strict';

const crypto = require('node:crypto');
const { readStaffSessionCookie } = require('./staff-session-cookie');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SUBMIT = /^\/internal\/submit\/([^/]+)$/;
const PREVIEW = /^\/internal\/workspaces\/([^/]+)\/preview$/;
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
});

// This is a navigation-only guard. The immutable review handler rechecks the
// owner's session and tenant before displaying any customer or invoice data.
// Attach AFTER the editor, preview and submission handlers so it can intercept
// their GET navigation; never intercept their POST handlers or JSON endpoints.
function attachBrowserSubmittedWorkspaceGuard(server, { origin, pool, businessId }) {
  let validOrigin = false;
  try {
    validOrigin = typeof origin === 'string' && origin.startsWith('https://') &&
      new URL(origin).origin === origin;
  } catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' ||
      server.listeners('request').length !== 1 || !validOrigin ||
      !pool || typeof pool.query !== 'function' ||
      typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated HTTPS origin and Facturations PostgreSQL pool required');
  }
  const tenant = businessId.trim();
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    if (request.method !== 'GET') return previous(request, response);
    let workspaceId = null;
    if (url.pathname === '/internal/editor') workspaceId = url.searchParams.get('id');
    else workspaceId = SUBMIT.exec(url.pathname)?.[1] ?? PREVIEW.exec(url.pathname)?.[1] ?? null;
    if (!workspaceId || !UUID.test(workspaceId) ||
        [...url.searchParams.keys()].some(key =>
          !['id', 'lang'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
        (url.pathname !== '/internal/editor' && url.searchParams.has('id'))) {
      return previous(request, response);
    }
    const lang = url.searchParams.get('lang') ?? 'fr';
    if (!['fr', 'en'].includes(lang) || url.hash ||
        request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) {
      return previous(request, response);
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return previous(request, response);
    try {
      // A valid, unrevoked OWNER session and ownership of the exact saved
      // workspace must BOTH match the dedicated tenant; UUIDs alone authorize nothing.
      const digest = crypto.createHash('sha256').update(token, 'utf8').digest();
      const found = await pool.query(
        `SELECT sub.draft_id FROM facturations_staff_sessions sess
           JOIN facturations_staff_users u
             ON u.business_id=sess.business_id AND u.id=sess.user_id
           JOIN facturations_draft_workspaces w
             ON w.business_id=u.business_id AND w.owner_staff_id=u.id AND w.id=$3
           JOIN facturations_workspace_submissions sub
             ON sub.business_id=w.business_id AND sub.workspace_id=w.id
          WHERE sess.business_id=$1 AND sess.token_hash=$2
            AND sess.revoked_at IS NULL AND sess.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'`,
        [tenant, digest, workspaceId]
      );
      if (found.rows.length === 0) return previous(request, response);
      if (found.rows.length !== 1 || !UUID.test(found.rows[0].draft_id)) throw new Error('Invalid mapping');
      response.writeHead(303, { ...HEADERS,
        Location: `/internal/review/${found.rows[0].draft_id}?lang=${lang}` });
      response.end();
    } catch {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(503, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Review navigation unavailable');
    }
  });
  return server;
}

module.exports = { attachBrowserSubmittedWorkspaceGuard };
