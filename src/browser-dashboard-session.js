'use strict';

const { readStaffSessionCookie } = require('./staff-session-cookie');

// This listener runs before createServer's request handler. It accepts cookies
// ONLY on the read-only HTML dashboard; API routes and writes remain unchanged.
// No cookies are issued by this module. Login, MFA and CSRF are separate gates.
function attachReadOnlyDashboardCookie(server) {
  if (!server || typeof server.prependListener !== 'function') {
    throw new TypeError('HTTP server required');
  }
  server.prependListener('request', (request) => {
    if (request.method !== 'GET' || typeof request.url !== 'string' ||
        !(request.url === '/internal/dashboard' || request.url.startsWith('/internal/dashboard?'))) return;
    // Explicit bearer auth always takes precedence. A shared admin header must
    // never be upgraded to a browser session, even if a cookie is also supplied.
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return;
    const token = readStaffSessionCookie(request.headers.cookie);
    if (token) request.headers.authorization = `Bearer ${token}`;
  });
  return server;
}

module.exports = { attachReadOnlyDashboardCookie };
