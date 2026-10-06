'use strict';

const crypto = require('node:crypto');

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function routeGroup(rawUrl) {
  let pathname;
  try { pathname = new URL(rawUrl, 'http://localhost').pathname; }
  catch { return 'OTHER'; }

  const exact = new Map([
    ['/health', 'HEALTH'],
    ['/ready', 'READY'],
    ['/internal/login', 'STAFF_LOGIN'],
    ['/internal/logout', 'STAFF_LOGOUT'],
    ['/internal/dashboard', 'DASHBOARD'],
    ['/internal/editor', 'EDITOR'],
    ['/internal/recent-workspaces', 'RECENT_WORKSPACES'],
    ['/internal/customers', 'CUSTOMERS'],
    ['/internal/customer-contact', 'CUSTOMER_CONTACT'],
    ['/internal/workspaces', 'WORKSPACES'],
    ['/internal/workspaces/csrf', 'WORKSPACE_CSRF'],
    ['/internal/review', 'REVIEW_LIST'],
    ['/portal/access', 'PORTAL_ACCESS'],
    ['/portal', 'PORTAL_LIST'],
    ['/portal/logout', 'PORTAL_LOGOUT'],
    ['/api/wave/businesses', 'API_WAVE_BUSINESSES'],
    ['/api/drafts/preview', 'API_DRAFT_PREVIEW'],
    ['/api/drafts', 'API_DRAFTS'],
    ['/api/dashboard/summary', 'API_DASHBOARD'],
    ['/api/customers', 'API_CUSTOMERS'],
    ['/api/approvals', 'API_APPROVALS'],
    ['/integration/v1/capabilities', 'INTEGRATION_CAPABILITIES'],
    ['/integration/v1/dashboard', 'INTEGRATION_DASHBOARD'],
    ['/integration/v1/drafts', 'INTEGRATION_DRAFTS'],
    ['/integration/v1/customers', 'INTEGRATION_CUSTOMERS'],
    ['/integration/v1/approvals', 'INTEGRATION_APPROVALS'],
    ['/integration/v1/handoffs/owner-review', 'INTEGRATION_OWNER_REVIEW_HANDOFF'],
    ['/webhooks/stripe/payments', 'WEBHOOK_STRIPE_PAYMENTS'],
  ]);
  if (exact.has(pathname)) return exact.get(pathname);

  const dynamic = [
    [/^\/internal\/workspaces\/[^/]+\/preview$/u, 'WORKSPACE_PREVIEW'],
    [/^\/internal\/workspaces\/[^/]+$/u, 'WORKSPACE_ITEM'],
    [/^\/internal\/submit\/[^/]+$/u, 'SUBMIT'],
    [/^\/internal\/review\/[^/]+\/print$/u, 'REVIEW_PRINT'],
    [/^\/internal\/review\/[^/]+\/authorize-issuance$/u, 'REVIEW_AUTHORIZE_ISSUANCE'],
    [/^\/internal\/review\/[^/]+$/u, 'REVIEW_ITEM'],
    [/^\/portal\/invoices\/[^/]+$/u, 'PORTAL_INVOICE'],
    [/^\/portal\/documents\/[^/]+\.pdf$/u, 'PORTAL_PDF'],
    [/^\/api\/drafts\/[^/]+$/u, 'API_DRAFT_ITEM'],
    [/^\/integration\/v1\/drafts\/[^/]+\/approval$/u, 'INTEGRATION_DRAFT_APPROVAL'],
    [/^\/integration\/v1\/drafts\/[^/]+\/workflow$/u, 'INTEGRATION_DRAFT_WORKFLOW'],
    [/^\/integration\/v1\/drafts\/[^/]+$/u, 'INTEGRATION_DRAFT_DETAIL'],
  ];
  for (const [pattern, name] of dynamic) {
    if (pattern.test(pathname)) return name;
  }
  return 'OTHER';
}

function attachOperationalTelemetry(server, {
  logger = line => console.info(line),
  idFactory = () => crypto.randomUUID(),
  clock = () => Date.now(),
  timestamp = () => new Date().toISOString(),
} = {}) {
  if (!server || typeof server.prependListener !== 'function') {
    throw new TypeError('HTTP server required');
  }
  if (typeof logger !== 'function' || typeof idFactory !== 'function' ||
      typeof clock !== 'function' || typeof timestamp !== 'function') {
    throw new TypeError('Telemetry dependencies must be functions');
  }

  server.prependListener('request', (request, response) => {
    const generated = idFactory();
    if (typeof generated !== 'string' || !REQUEST_ID.test(generated)) {
      return;
    }

    const requestId = generated.toLowerCase();
    // Make only the server-generated correlation ID available to downstream handlers.
    // Caller-supplied X-Request-ID is intentionally ignored.
    request.requestId = requestId;
    const method = typeof request.method === 'string' &&
      /^[A-Z]{1,12}$/u.test(request.method) ? request.method : 'OTHER';
    const route = routeGroup(request.url);
    const startedAt = clock();
    let emitted = false;

    try {
      if (!response.headersSent) response.setHeader('X-Request-ID', requestId);
    } catch {
      // Telemetry must never interrupt request handling.
    }

    function emit(outcome) {
      if (emitted) return;
      emitted = true;
      const endedAt = clock();
      const rawDuration = Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? endedAt - startedAt : 0;
      const durationMs = Math.max(0, Math.min(3_600_000, Math.round(rawDuration)));
      const event = {
        ts: timestamp(),
        event: 'http_request',
        requestId,
        method,
        route,
        statusCode: outcome === 'finished' && Number.isInteger(response.statusCode)
          ? response.statusCode : null,
        durationMs,
        outcome,
      };
      try { logger(JSON.stringify(event)); } catch {
        // Operational logging must never crash or alter the response.
      }
    }

    response.once('finish', () => emit('finished'));
    response.once('close', () => emit('closed'));
  });

  return server;
}

module.exports = { attachOperationalTelemetry, routeGroup };
