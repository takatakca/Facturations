'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { listBusinesses, WaveError } = require('./wave-client');
const { previewDraft, DraftValidationError } = require('./draft-preview');

const MAX_BODY_BYTES = 32768;

function sendJson(response, statusCode, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const actualDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    let finished = false;
    function fail(code, statusCode) {
      if (finished) return;
      finished = true;
      reject({ code, statusCode });
    }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      request.resume();
      return fail('BODY_TOO_LARGE', 413);
    }
    request.on('data', (chunk) => {
      if (finished) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        chunks.length = 0;
        return fail('BODY_TOO_LARGE', 413);
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject({ code: 'INVALID_JSON', statusCode: 400 }); }
    });
    request.on('error', () => fail('INVALID_REQUEST', 400));
  });
}

function createServer({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) throw new Error('Server config is required');

  return http.createServer(async (request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/health') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return sendJson(response, 200, { ok: true, service: 'takatak-wave', phase: 2 });
    }

    if (path !== '/api/wave/businesses' && path !== '/api/drafts/preview') {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    const expectedMethod = path === '/api/drafts/preview' ? 'POST' : 'GET';
    if (request.method !== expectedMethod) {
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (!config.adminKey) return sendJson(response, 503, { error: 'ADMIN_NOT_CONFIGURED' });
    if (!isAuthorized(request.headers['x-admin-key'], config.adminKey)) {
      return sendJson(response, 401, { error: 'UNAUTHORIZED' });
    }

    if (path === '/api/drafts/preview') {
      if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers['content-type'] || '')) {
        return sendJson(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      }
      try {
        const draft = await readJson(request);
        return sendJson(response, 200, previewDraft(draft));
      } catch (error) {
        if (error instanceof DraftValidationError) {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        if (error && typeof error.statusCode === 'number') {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        return sendJson(response, 500, { error: 'INTERNAL_ERROR' });
      }
    }

    if (!config.waveToken) return sendJson(response, 503, { error: 'WAVE_NOT_CONFIGURED' });
    try {
      const result = await listBusinesses({ token: config.waveToken, fetchImpl });
      return sendJson(response, 200, { connected: true, ...result });
    } catch (error) {
      if (error instanceof WaveError) {
        return sendJson(response, error.statusCode, { connected: false, error: error.code });
      }
      return sendJson(response, 502, { connected: false, error: 'WAVE_UNAVAILABLE' });
    }
  });
}

module.exports = { createServer, isAuthorized };
