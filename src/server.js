'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { listBusinesses, WaveError } = require('./wave-client');
const { previewDraft, DraftValidationError } = require('./draft-preview');
const { StoreError } = require('./draft-store');
const { DashboardError, pageOptions } = require('./dashboard-store');
const { renderDashboard } = require('./dashboard-view');
const { CustomerDirectoryError, customerListOptions } = require('./customer-directory');
const { ApprovalLedgerError, approvalPageOptions } = require('./approval-ledger');
const { resolveReadOnlyStaff } = require('./staff-read-access');
const { verifyIntegrationBearer, IntegrationAuthError } = require('./integration-auth');

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

function sendHtml(response, html) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  response.end(html);
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
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
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

function resolveIntegrationPrincipal(request, config) {
  if (!config.integrationEnabled) throw new IntegrationAuthError('INTEGRATION_DISABLED', 404);
  return verifyIntegrationBearer({
    authorization: request.headers.authorization,
    secret: config.integrationSecret,
    issuer: config.integrationIssuer,
    audience: config.integrationAudience,
    businessId: config.businessId,
  });
}

function createServer({ config, fetchImpl = globalThis.fetch, draftStore = null, dashboardStore = null,
  staffAuthStore = null, customerDirectory = null, approvalLedger = null, readinessCheck = null } = {}) {
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
    if (path === '/ready') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (typeof readinessCheck !== 'function') {
        return sendJson(response, 503, { ok: false, service: 'takatak-wave' });
      }
      let ready = false;
      try { ready = await readinessCheck(); } catch { ready = false; }
      return sendJson(response, ready ? 200 : 503, { ok: ready, service: 'takatak-wave' });
    }

    const isPreview = path === '/api/drafts/preview';
    const isCollection = path === '/api/drafts';
    const isGet = /^\/api\/drafts\/[^/]+$/.test(path) && !isPreview;
    const isWave = path === '/api/wave/businesses';
    const isDashboard = path === '/api/dashboard/summary';
    const isHtml = path === '/internal/dashboard';
    const isCustomers = path === '/api/customers';
    const isApprovals = path === '/api/approvals';
    const isIntegrationCapabilities = path === '/integration/v1/capabilities';
    const isIntegrationDashboard = path === '/integration/v1/dashboard';
    const isIntegrationDrafts = path === '/integration/v1/drafts';
    const isIntegrationCustomers = path === '/integration/v1/customers';
    const isIntegrationApprovals = path === '/integration/v1/approvals';
    const integrationDraftDetailMatch = /^\/integration\/v1\/drafts\/([^/]+)$/.exec(path);
    const isIntegrationDraftDetail = Boolean(integrationDraftDetailMatch);
    if (!isPreview && !isCollection && !isGet && !isWave && !isDashboard && !isCustomers && !isApprovals && !isHtml && !isIntegrationCapabilities && !isIntegrationDashboard && !isIntegrationDrafts && !isIntegrationCustomers && !isIntegrationApprovals && !isIntegrationDraftDetail) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }

    if (isIntegrationCapabilities || isIntegrationDashboard || isIntegrationDrafts || isIntegrationCustomers || isIntegrationApprovals || isIntegrationDraftDetail) {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if ((isIntegrationCapabilities || isIntegrationDashboard || isIntegrationDraftDetail) &&
          [...url.searchParams.keys()].length) {
        return sendJson(response, 422, { error: 'INVALID_QUERY' });
      }
      let principal;
      try {
        principal = resolveIntegrationPrincipal(request, config);
      } catch (error) {
        if (error instanceof IntegrationAuthError) {
          const code = error.code === 'INTEGRATION_DISABLED' ? 'NOT_FOUND' : error.code;
          return sendJson(response, error.statusCode, { error: code });
        }
        return sendJson(response, 503, { error: 'INTEGRATION_AUTH_UNAVAILABLE' });
      }

      if (isIntegrationCapabilities) {
        return sendJson(response, 200, {
          version: 1,
          requestId: request.requestId || null,
          businessId: principal.businessId,
          data: {
            service: 'facturations',
            integrationVersion: 1,
            capabilities: {
              capabilitiesRead: true,
              dashboardRead: true,
              draftsRead: true,
              draftDetailsRead: principal.roles.includes('OWNER'),
              customersRead: principal.roles.includes('OWNER'),
              approvalsRead: principal.roles.includes('OWNER'),
              draftWrite: false,
              ownerApprovalWrite: false,
              issuanceAuthorizationWrite: false,
              deliveryAuthorizationWrite: false,
              portalPublicationWrite: false,
            },
            standalone: {
              staffWorkspace: true,
              clientPortal: true,
              bilingual: ['fr', 'en'],
            },
          },
        });
      }

      if (isIntegrationDraftDetail) {
        if (!principal.roles.includes('OWNER')) {
          return sendJson(response, 403, { error: 'OWNER_REQUIRED' });
        }
        if (!draftStore) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
        try {
          const stored = await draftStore.getDraft(integrationDraftDetailMatch[1]);
          if (!stored || stored.status !== 'DRAFT' || !stored.preview ||
              typeof stored.preview !== 'object' || Array.isArray(stored.preview)) {
            return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
          }
          const snapshot = stored.preview;
          if (!snapshot.customer || typeof snapshot.customer !== 'object' ||
              !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.taxes)) {
            return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
          }
          const recalculated = previewDraft({
            currency: snapshot.currency,
            customer: {
              name: snapshot.customer.name,
              email: snapshot.customer.email,
              address: snapshot.customer.address ?? null,
            },
            invoiceDate: snapshot.invoiceDate,
            dueDate: snapshot.dueDate,
            notes: snapshot.notes ?? null,
            lines: snapshot.lines.map(line => ({
              description: line.description,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              discountCents: line.discountCents ?? 0,
              taxable: line.taxable,
            })),
            taxes: snapshot.taxes.map(tax => ({
              code: tax.code,
              label: tax.label,
              rateMilliPercent: tax.rateMilliPercent,
            })),
          });
          return sendJson(response, 200, {
            version: 1,
            requestId: request.requestId || null,
            businessId: principal.businessId,
            data: {
              id: stored.id,
              status: 'DRAFT',
              preview: recalculated,
            },
          });
        } catch (error) {
          if (error instanceof StoreError || error instanceof DraftValidationError) {
            return sendJson(response, error.statusCode, { error: error.code });
          }
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
      }

      if (isIntegrationApprovals) {
        if (!principal.roles.includes('OWNER')) {
          return sendJson(response, 403, { error: 'OWNER_REQUIRED' });
        }
        if (!approvalLedger) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
        let options;
        try { options = approvalPageOptions(url.searchParams); }
        catch (error) {
          if (error instanceof ApprovalLedgerError || error instanceof DashboardError) {
            return sendJson(response, error.statusCode, { error: error.code });
          }
          return sendJson(response, 422, { error: 'INVALID_QUERY' });
        }
        try {
          const listed = await approvalLedger.listApprovals(options);
          if (!listed || listed.status !== 'INTERNAL_APPROVALS_ONLY' ||
              listed.currency !== 'CAD' ||
              !Number.isInteger(listed.page) || !Number.isInteger(listed.pageSize) ||
              typeof listed.hasMore !== 'boolean' ||
              !Array.isArray(listed.approvals) || listed.approvals.length > listed.pageSize) {
            return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
          }
          const safeApprovals = [];
          for (const approval of listed.approvals) {
            if (!approval || typeof approval.id !== 'string' ||
                typeof approval.draftId !== 'string' ||
                typeof approval.approvedAt !== 'string' ||
                typeof approval.totalCents !== 'string' ||
                approval.status !== 'APPROVED_INTERNAL_ONLY' ||
                approval.issued !== false ||
                approval.waveSynced !== false ||
                approval.emailed !== false ||
                approval.paid !== false) {
              return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
            }
            safeApprovals.push({
              id: approval.id,
              draftId: approval.draftId,
              approvedAt: approval.approvedAt,
              totalCents: approval.totalCents,
              currency: 'CAD',
              status: 'APPROVED_INTERNAL_ONLY',
              issued: false,
              waveSynced: false,
              emailed: false,
              paid: false,
            });
          }
          return sendJson(response, 200, {
            version: 1,
            requestId: request.requestId || null,
            businessId: principal.businessId,
            data: {
              status: 'INTERNAL_APPROVALS_ONLY',
              currency: 'CAD',
              page: listed.page,
              pageSize: listed.pageSize,
              hasMore: listed.hasMore,
              approvals: safeApprovals,
            },
          });
        } catch {
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
      }

      if (isIntegrationCustomers) {
        if (!principal.roles.includes('OWNER')) {
          return sendJson(response, 403, { error: 'OWNER_REQUIRED' });
        }
        if (!customerDirectory) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
        let options;
        try { options = customerListOptions(url.searchParams); }
        catch (error) {
          if (error instanceof CustomerDirectoryError || error instanceof DashboardError) {
            return sendJson(response, error.statusCode, { error: error.code });
          }
          return sendJson(response, 422, { error: 'INVALID_QUERY' });
        }
        try {
          const listed = await customerDirectory.listCustomers(options);
          if (!listed || listed.status !== 'CUSTOMERS_ONLY' ||
              !Number.isInteger(listed.page) || !Number.isInteger(listed.pageSize) ||
              typeof listed.hasMore !== 'boolean' ||
              !Array.isArray(listed.customers) || listed.customers.length > listed.pageSize) {
            return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
          }
          const safeCustomers = [];
          for (const customer of listed.customers) {
            if (!customer || typeof customer.id !== 'string' ||
                typeof customer.name !== 'string' ||
                typeof customer.email !== 'string') {
              return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
            }
            safeCustomers.push({
              id: customer.id,
              name: customer.name,
              email: customer.email,
            });
          }
          return sendJson(response, 200, {
            version: 1,
            requestId: request.requestId || null,
            businessId: principal.businessId,
            data: {
              status: 'CUSTOMERS_ONLY',
              page: listed.page,
              pageSize: listed.pageSize,
              hasMore: listed.hasMore,
              customers: safeCustomers,
            },
          });
        } catch {
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
      }

      if (!dashboardStore) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });

      if (isIntegrationDrafts) {
        let options;
        try { options = parseListOptions(url.searchParams); }
        catch (error) {
          if (error instanceof DashboardError) {
            return sendJson(response, error.statusCode, { error: error.code });
          }
          return sendJson(response, 422, { error: 'INVALID_QUERY' });
        }
        try {
          const listed = await dashboardStore.listDrafts(options);
          if (!listed || listed.status !== 'DRAFTS_ONLY' ||
              !Number.isInteger(listed.page) || !Number.isInteger(listed.pageSize) ||
              !Array.isArray(listed.drafts) || listed.drafts.length > listed.pageSize) {
            return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
          }
          const safeDrafts = [];
          for (const draft of listed.drafts) {
            if (!draft || typeof draft.id !== 'string' ||
                typeof draft.customerName !== 'string' ||
                typeof draft.invoiceDate !== 'string' ||
                typeof draft.dueDate !== 'string' ||
                typeof draft.totalCents !== 'string' ||
                draft.currency !== 'CAD' || draft.status !== 'DRAFT') {
              return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
            }
            safeDrafts.push({
              id: draft.id,
              customerName: draft.customerName,
              invoiceDate: draft.invoiceDate,
              dueDate: draft.dueDate,
              totalCents: draft.totalCents,
              currency: 'CAD',
              status: 'DRAFT',
            });
          }
          return sendJson(response, 200, {
            version: 1,
            requestId: request.requestId || null,
            businessId: principal.businessId,
            data: {
              status: 'DRAFTS_ONLY',
              page: listed.page,
              pageSize: listed.pageSize,
              drafts: safeDrafts,
            },
          });
        } catch {
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
      }

      try {
        const summary = await dashboardStore.getSummary();
        if (!summary || summary.status !== 'DRAFTS_ONLY' || summary.currency !== 'CAD') {
          return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
        }
        return sendJson(response, 200, {
          version: 1,
          requestId: request.requestId || null,
          businessId: principal.businessId,
          data: {
            status: 'DRAFTS_ONLY',
            currency: 'CAD',
            draftCount: summary.draftCount,
            draftTotalCents: summary.draftTotalCents,
            customerCount: summary.customerCount,
            issuedInvoicesAvailable: false,
            paymentsAvailable: false,
            revenueAvailable: false,
          },
        });
      } catch {
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
      }
    }

    const expectedMethod = isPreview ? 'POST' : isCollection ? null : 'GET';
    if ((expectedMethod && request.method !== expectedMethod) ||
        (isCollection && !['GET', 'POST'].includes(request.method))) {
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    // The HTML view rejects X-Admin-Key. Never embed a shared admin key or bearer
    // token in browser code. Normal browser navigation needs separate secure login.
    if (isHtml && request.headers.authorization === undefined) {
      return sendJson(response, 401, { error: 'UNAUTHORIZED' });
    }

    // Navigation is presentation only; the review route rechecks live OWNER and tenant rights.
    let ownerReview = false;
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
      ownerReview = Boolean(config.browserOrigin && staff.role === 'OWNER');
      if (!((isDashboard || isCollection || isGet || isCustomers || isApprovals || isHtml) && request.method === 'GET')) {
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

    if (isHtml) {
      if (!dashboardStore) return sendJson(response, 503, { error: 'STORAGE_NOT_CONFIGURED' });
      if ([...url.searchParams.keys()].some(key => key !== 'lang') || url.searchParams.getAll('lang').length > 1) {
        return sendJson(response, 422, { error: 'INVALID_QUERY' });
      }
      const language = url.searchParams.get('lang') ?? 'fr';
      if (!['fr', 'en'].includes(language)) return sendJson(response, 422, { error: 'INVALID_LANGUAGE' });
      try {
        const [summary, drafts] = await Promise.all([
          dashboardStore.getSummary(), dashboardStore.listDrafts(pageOptions('1', '20')),
        ]);
        return sendHtml(response, renderDashboard({ summary, drafts, language, ownerReview }));
      } catch {
        return sendJson(response, 503, { error: 'STORAGE_UNAVAILABLE' });
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
