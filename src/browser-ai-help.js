'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { OpenAiAssistantError } = require('./openai-assistant-client');

const MAX_BODY_BYTES = 8192;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

function reply(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, HEADERS);
  response.end(JSON.stringify(body));
}

function sameOrigin(request, origin) {
  return request.headers.origin === origin &&
    request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined ||
      request.headers['sec-fetch-site'] === 'same-origin');
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
    if (declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      return fail(413);
    }
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
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(chunks))));
      } catch {
        reject(400);
      }
    });
  });
}

function exactFields(payload, fields) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).length === fields.length &&
    Object.keys(payload).every(key => fields.includes(key));
}

function attachBrowserAiHelp(server, {
  origin,
  encryptionKeyHex,
  staffAuthStore,
  assistantClient,
} = {}) {
  let validOrigin = false;
  try {
    validOrigin = typeof origin === 'string' &&
      origin.startsWith('https://') &&
      new URL(origin).origin === origin;
  } catch { /* Fail closed. */ }

  if (!server || typeof server.listeners !== 'function' ||
      server.listeners('request').length !== 1 ||
      !validOrigin ||
      !/^[a-f0-9]{64}$/iu.test(encryptionKeyHex || '') ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !assistantClient || typeof assistantClient.help !== 'function') {
    throw new TypeError('Private HTTPS AI help service required');
  }

  const csrfKey = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-ai-help-csrf-key-v1')
    .digest();
  const csrfFor = token => crypto.createHmac('sha256', csrfKey)
    .update('ai-help-v1:')
    .update(token)
    .digest('base64url');

  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }

    const csrfRoute = url.pathname === '/internal/assistant/csrf';
    const helpRoute = url.pathname === '/internal/assistant/help';
    if (!csrfRoute && !helpRoute) return previous(request, response);

    if (url.search || url.hash) {
      return reply(response, 422, { error: 'INVALID_QUERY' });
    }
    if (request.headers.authorization !== undefined ||
        request.headers['x-admin-key'] !== undefined) {
      return reply(response, 401, { error: 'UNAUTHORIZED' });
    }

    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return reply(response, 401, { error: 'UNAUTHORIZED' });

    if ((csrfRoute && request.method !== 'GET') ||
        (helpRoute && request.method !== 'POST')) {
      return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    let staff;
    try { staff = await staffAuthStore.getSession(token); }
    catch { return reply(response, 503, { error: 'AUTH_UNAVAILABLE' }); }
    if (!staff || !['OWNER', 'STAFF'].includes(staff.role)) {
      return reply(response, 401, { error: 'UNAUTHORIZED' });
    }

    if (csrfRoute) {
      return reply(response, 200, { csrfToken: csrfFor(token) });
    }

    if (!sameOrigin(request, origin)) {
      return reply(response, 403, { error: 'ORIGIN_FORBIDDEN' });
    }
    const supplied = request.headers['x-facturations-ai-csrf'];
    const expected = csrfFor(token);
    if (typeof supplied !== 'string' ||
        !CSRF_TOKEN.test(supplied) ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return reply(response, 403, { error: 'CSRF_FORBIDDEN' });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      request.headers['content-type'] || ''
    )) {
      return reply(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
    }

    let payload;
    try { payload = await readBody(request); }
    catch (status) {
      return reply(response, status, {
        error: status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      });
    }
    if (!exactFields(payload, ['language', 'screenId', 'message'])) {
      return reply(response, 422, { error: 'INVALID_AI_HELP_REQUEST' });
    }

    try {
      const result = await assistantClient.help(payload);
      return reply(response, 200, {
        answer: result.answer,
        safety: {
          decision: result.safety.decision,
          reasonCode: result.safety.reasonCode,
          requiredGate: result.safety.requiredGate,
          proposalFingerprint: result.safety.proposalFingerprint,
          directExecutionAllowed: false,
        },
      });
    } catch (error) {
      if (error instanceof OpenAiAssistantError) {
        return reply(response, error.statusCode, { error: error.code });
      }
      return reply(response, 503, { error: 'AI_UNAVAILABLE' });
    }
  });

  return server;
}

module.exports = { attachBrowserAiHelp };
