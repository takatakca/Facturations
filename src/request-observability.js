'use strict';

const crypto = require('node:crypto');

const STATIC_ROUTES = new Set([
  '/health',
  '/ready',
  '/internal/login',
  '/internal/logout',
  '/internal/dashboard',
  '/internal/editor',
  '/internal/recent-workspaces',
  '/internal/customers',
  '/internal/customer-contact',
  '/internal/workspaces/csrf',
  '/internal/review',
  '/portal/access',
  '/portal',
  '/portal/logout',
  '/api/wave/businesses',
  '/api/dashboard/summary',
  '/api/customers',
  '/api/approvals',
  '/api/drafts',
  '/api/drafts/preview',
]);

const DYNAMIC_ROUTES = Object.freeze([
  [/^\/portal\/invoices\/[^/]+$/u, '/portal/invoices/:id'],
  [/^\/portal\/documents\/[^/]+\.pdf$/u, '/portal/documents/:id.pdf'],
  [/^\/internal\/workspaces\/[^/]+\/preview$/u, '/internal/workspaces/:id/preview'],
  [/^\/internal\/workspaces\/[^/]+$/u, '/internal/workspaces/:id'],
  [/^\/internal\/submit\/[^/]+$/u, '/internal/submit/:id'],
  [/^\/internal\/review\/[^/]+\/authorize-issuance$/u, '/internal/review/:id/authorize-issuance'],
  [/^\/internal\/review\/[^/]+\/print$/u, '/internal/review/:id/print'],
  [/^\/internal\/review\/[^/]+$/u, '/internal/review/:id'],
  [/^\/api\/drafts\/[^/]+$/u, '/api/drafts/:id'],
]);

function routeTemplate(rawUrl) {
  let pathname;
  try { pathname = new URL(rawUrl, 'http://localhost').pathname; }
  catch { return '/invalid'; }
  if (STATIC_ROUTES.has(pathname)) return pathname;
  for (const [pattern, template] of DYNAMIC_ROUTES) {
    if (pattern.test(pathname)) return template;
  }
  return '/other';
}

function attachRequestObservability(server, {
  logger,
  idFactory = () => crypto.randomUUID(),
  clock = () => process.hrtime.bigint(),
} = {}) {
  if (!server || typeof server.listeners !== 'function' ||
      typeof server.removeAllListeners !== 'function' || typeof server.on !== 'function') {
    throw new TypeError('HTTP server required');
  }
  if (!logger || typeof logger.info !== 'function' ||
      typeof logger.warn !== 'function' || typeof logger.error !== 'function') {
    throw new TypeError('Operational logger required');
  }
  if (typeof idFactory !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Observability dependencies must be functions');
  }

  const listeners = server.listeners('request');
  if (listeners.length < 1) throw new TypeError('Request handler required');
  server.removeAllListeners('request');

  server.on('request', (request, response) => {
    const requestId = String(idFactory());
    const route = routeTemplate(request.url);
    const started = clock();
    let finished = false;

    if (!response.headersSent) response.setHeader('X-Request-ID', requestId);

    function done(state) {
      if (finished) return;
      finished = true;
      const elapsed = clock() - started;
      const durationMs = typeof elapsed === 'bigint'
        ? Number(elapsed / 1000000n)
        : Math.max(0, Math.trunc(Number(elapsed) || 0));
      const fields = {
        requestId,
        method: String(request.method || 'UNKNOWN').slice(0, 16),
        route,
        statusCode: response.statusCode,
        durationMs,
        component: 'http',
        state,
      };
      if (response.statusCode >= 500) logger.error('http_request', fields);
      else if (response.statusCode >= 400) logger.warn('http_request', fields);
      else logger.info('http_request', fields);
    }

    response.once('finish', () => done('finished'));
    response.once('close', () => done(response.writableEnded ? 'finished' : 'aborted'));

    for (const listener of listeners) {
      listener.call(server, request, response);
    }
  });

  return server;
}

module.exports = { attachRequestObservability, routeTemplate };
