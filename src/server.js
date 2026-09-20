'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { listBusinesses, WaveError } = require('./wave-client');
const { previewDraft, DraftValidationError } = require('./draft-preview');
const { StoreError } = require('./draft-store');
const { DashboardError, pageOptions } = require('./dashboard-store');
const { CustomerDirectoryError, customerListOptions } = require('./customer-directory');
const { ApprovalLedgerError, approvalPageOptions } = require('./approval-ledger');
const { resolveReadOnlyStaff } = require('./staff-read-access');

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

function parseListOptions(searchParams) {
  for (const key of searchParams.keys()) {
    if (!['page', 'pageSize'].includes(key) || searchParams.getAll(key).length !== 1) {
      throw new DashboardError('INVALID_QUERY');
    }
  }
  return pageOptions(searchParams.get('page') ?? '1', searchParams.get('pageSize') ?? '20');
}

function createServer({ config, fetchImpl = globalThis.fetch, draftStore = null, dashboardStore = null,
  staffAuthStore = null, customerDirectory = null, approvalLedger = null } = {}) {
  if (!config) throw new Error('Server config is required');

  return http.createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return sendJson(response, 400, { error: 'INVALID_URL' }); }
    const path = url.pathname;
    if (path === '/health') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return sendJson(response, 200, { ok: true, service: 'takatak-wave', phase: 3 });
    }

    const isPreview = path === '/api/drafts/preview';
    const isCollection = path === '/api/drafts';
    const isGet = /^\/api\/drafts\/[^/]+$/.test(path) && !isPreview;
    const isWave = path === '/api/wave/businesses';
    const isDashboard = path === '/api/dashboard/summary';
    const isCustomers = path === '/api/customers';
    const isApprovals = path === '/api/approvals';
    if (!isPreview && !isCollection && !isGet && !isWave && !isDashboard && !isCustomers && !isApprovals) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }

    const expectedMethod = isPreview ? 'POST' : isCollection ? null : 'GET';
    if ((expectedMethod && request.method !== expectedMethod) ||
        (isCollection && !['GET', 'POST'].includes(request.method))) {
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    // Staff may list tenant-scoped draft summaries. Full drafts, customer contacts,
    // and internal approvals are OWNER-only. Admin key stays server-to-server ONLY.
    if (request.headers.authorization !== undefined) {
      let staff;
      try {
        staff = await resolveReadOnlyStaff({ authorization: request.headers.authorization,
          store: staffAuthStore, businessId: config.businessId });
      } catch {
        return sendJson(response, 503, { error: 'AUTH_UNAVAILABLE' });
      }
      if (!staff) return sendJson(response, 401, { error: 'UNAUTHORIZED' });
      if (!((isDashboard || isCollection || isGet || isCustomers || isApprovals) && request.method === 'GET')) {
        return sendJson(response, 403, { error: 'STAFF_READ_ONLY' });
      }
      if ((isCustomers || isGet || isApprovals) && staff.role !== 'OWNER') {
        return sendJson(response, 403, { error: 'OWNER_REQUIRED' });
      }
    } else {
      if (!config.adminKey) return sendJson(response, 503, { error: 'ADMIN_NOT_CONFIGURED' });
      if (!isAuthorized(request.headers['x-admin-key'], config.adminKey)) {
        return sendJson(response, 401, { error: 'UNAUTHORIZED' });
      }
    }

    if (isApprovals) {
      if (!approvalLedger) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
      try {
        return sendJson(response, 200, await approvalLedger.listApprovals(approvalPageOptions(url.searchParams)));
      } catch (error) {
        if (error instanceof ApprovalLedgerError || error instanceof DashboardError) {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
      }
    }

    if (isCustomers) {
      if (!customerDirectory) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
      try {
        return sendJson(response, 200, await customerDirectory.listCustomers(customerListOptions(url.searchParams)));
      } catch (error) {
        if (error instanceof CustomerDirectoryError || error instanceof DashboardError) {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
      }
    }

    if (isDashboard || (isCollection && request.method === 'GET')) {
      if (!dashboardStore) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
      try {
        if (isDashboard) {
          if ([...url.searchParams.keys()].length) throw new DashboardError('INVALID_QUERY');
          return sendJson(response, 200, await dashboardStore.getSummary());
        }
        return sendJson(response, 200, await dashboardStore.listDrafts(parseListOptions(url.searchParams)));
      } catch (error) {
        if (error instanceof DashboardError) return sendJson(response, error.statusCode, { error: error.code });
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
      }
    }

    if (isPreview || isCollection || isGet) {
      if (!isPreview && !draftStore) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
      if (isGet) {
        try {
          const draft = await draftStore.getDraft(path.slice('/api/drafts/'.length));
          return sendJson(response, 200, draft);
        } catch (error) {
          if (error instanceof StoreError) return sendJson(response, error.statusCode, { error: error.code });
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
      }
      if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers['content-type'] || '')) {
        return sendJson(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      }
      try {
        const payload = await readJson(request);
        if (isPreview) return sendJson(response, 200, previewDraft(payload));
        const key = request.headers['idempotency-key'];
        const stored = await draftStore.createDraft(payload, key);
        return sendJson(response, 200, stored);
      } catch (error) {
        if (error instanceof DraftValidationError || error instanceof StoreError) {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        if (error && typeof error.statusCode === 'number' &&
          ['BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_REQUEST'].includes(error.code)) {
          return sendJson(response, error.statusCode, { error: error.code });
        }
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
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

module.exports = { createServer, isAuthorized, parseListOptions };
