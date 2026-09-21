'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { WorkspaceError } = require('./draft-workspace-store');

const MAX_BODY_BYTES = 32768;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
function reply(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, HEADERS);
  response.end(JSON.stringify(body));
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let done = false;
    let size = 0;
    const chunks = [];
    function fail(status) {
      if (done) return;
      done = true;
      request.resume();
      reject(status);
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return fail(413);
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(413);
      chunks.push(chunk);
    });
    request.on('error', () => fail(400));
    request.on('aborted', () => fail(400));
    request.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(400); }
    });
  });
}
function exactFields(payload, fields) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === fields.length && Object.keys(payload).every(key => fields.includes(key));
}

// Attach AFTER the browser-login wrapper and BEFORE the dashboard-cookie listener.
// Never accept X-Admin-Key, Authorization, URL tokens or caller-selected tenant IDs.
function attachBrowserWorkspaceRoutes(server, { origin, encryptionKeyHex, staffAuthStore, workspaceStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex || '') ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !workspaceStore || ['create', 'load', 'save'].some(method => typeof workspaceStore[method] !== 'function')) {
    throw new TypeError('Private HTTPS workspace service and MFA key required');
  }
  // Derive a separate HMAC key, never directly reuse the MFA encryption key.
  const csrfKey = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-workspace-csrf-key-v1').digest();
  const csrfFor = token => crypto.createHmac('sha256', csrfKey)
    .update('workspace-write-v1:').update(token).digest('base64url');
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const collection = url.pathname === '/internal/workspaces';
    const csrf = url.pathname === '/internal/workspaces/csrf';
    const match = /^\/internal\/workspaces\/([^/]+)$/.exec(url.pathname);
    if (!collection && !csrf && !match) return previous(request, response);
    if (url.search || url.hash) return reply(response, 422, { error: 'INVALID_QUERY' });
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) {
      return reply(response, 401, { error: 'UNAUTHORIZED' });
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return reply(response, 401, { error: 'UNAUTHORIZED' });
    const item = Boolean(match) && !csrf;
    if ((collection && request.method !== 'POST') || (csrf && request.method !== 'GET') ||
        (item && !['GET', 'PUT'].includes(request.method))) {
      return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (item && !UUID.test(match[1])) return reply(response, 422, { error: 'INVALID_WORKSPACE_ID' });
    const write = collection || request.method === 'PUT';
    if (write) {
      if (!sameOrigin(request, origin)) return reply(response, 403, { error: 'ORIGIN_FORBIDDEN' });
      const supplied = request.headers['x-facturations-csrf'];
      const expected = csrfFor(token);
      // Compare only the fixed-width ASCII Base64URL encoding, not UTF-16 string length.
      // A Unicode string can have 43 characters but more than 43 UTF-8 bytes, which
      // makes timingSafeEqual throw outside the request's error handler.
      if (typeof supplied !== 'string' || !CSRF_TOKEN.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return reply(response, 403, { error: 'CSRF_FORBIDDEN' });
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
        return reply(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      }
    }
    try {
      if (csrf) {
        const staff = await staffAuthStore.getSession(token);
        if (!staff || !['OWNER', 'STAFF'].includes(staff.role)) return reply(response, 401, { error: 'UNAUTHORIZED' });
        return reply(response, 200, { csrfToken: csrfFor(token) });
      }
      if (!write) return reply(response, 200, await workspaceStore.load({ token, workspaceId: match[1] }));
      const payload = await readBody(request);
      if (collection) {
        if (!exactFields(payload, ['creationKey', 'content'])) return reply(response, 422, { error: 'INVALID_WORKSPACE_REQUEST' });
        return reply(response, 200, await workspaceStore.create({ token, ...payload }));
      }
      if (!exactFields(payload, ['expectedRevision', 'content'])) return reply(response, 422, { error: 'INVALID_WORKSPACE_REQUEST' });
      return reply(response, 200, await workspaceStore.save({ token, workspaceId: match[1], ...payload }));
    } catch (error) {
      if (error instanceof WorkspaceError) return reply(response, error.statusCode, { error: error.code });
      if (error === 400 || error === 413) return reply(response, error, { error: error === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
      return reply(response, 503, { error: 'STORAGE_UNAVAILABLE' });
    }
  });
  return server;
}
module.exports = { attachBrowserWorkspaceRoutes };
