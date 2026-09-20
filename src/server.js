'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { listBusinesses, WaveError } = require('./wave-client');

function sendJson(response, statusCode, body) {
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
  // Fixed-length SHA-256 digests prevent length-dependent key comparisons.
  const actualDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function createServer({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) throw new Error('Server config is required');

  return http.createServer(async (request, response) => {
    // A fixed route table; no public static files, OAuth, invoice, or email routes.
    const path = request.url?.split('?')[0];

    if (path === '/health') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return sendJson(response, 200, { ok: true, service: 'takatak-wave', phase: 1 });
    }

    if (path !== '/api/wave/businesses') {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    if (request.method !== 'GET') {
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (!config.adminKey) {
      return sendJson(response, 503, { error: 'ADMIN_NOT_CONFIGURED' });
    }
    if (!isAuthorized(request.headers['x-admin-key'], config.adminKey)) {
      return sendJson(response, 401, { error: 'UNAUTHORIZED' });
    }
    if (!config.waveToken) {
      return sendJson(response, 503, { error: 'WAVE_NOT_CONFIGURED' });
    }

    try {
      const result = await listBusinesses({ token: config.waveToken, fetchImpl });
      return sendJson(response, 200, { connected: true, ...result });
    } catch (error) {
      if (error instanceof WaveError) {
        return sendJson(response, error.statusCode, { connected: false, error: error.code });
      }
      // Do not reflect upstream errors, credentials, GraphQL payloads or stack traces.
      return sendJson(response, 502, { connected: false, error: 'WAVE_UNAVAILABLE' });
    }
  });
}

module.exports = { createServer, isAuthorized };
