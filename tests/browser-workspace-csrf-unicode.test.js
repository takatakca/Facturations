'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const { attachBrowserWorkspaceRoutes } = require('../src/browser-workspace-routes');
const { COOKIE_NAME } = require('../src/staff-session-cookie');

const TOKEN = 'A'.repeat(43); // Synthetic token, not a real session.
const CREATION_KEY = 'synthetic-key-123456';

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const client = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { Connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    client.on('error', reject);
    client.end(body);
  });
}

test('malformed multi-byte CSRF headers fail 403 without terminating the HTTP service', async () => {
  let creates = 0;
  const server = createServer({ config: { businessId: 'synthetic-csrf-test', adminKey: 'synthetic-admin-key', waveToken: null } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `https://127.0.0.1:${port}`;
  attachBrowserWorkspaceRoutes(server, {
    origin,
    encryptionKeyHex: '7'.repeat(64), // Synthetic test key, not a real MFA key.
    staffAuthStore: { async getSession(token) { return token === TOKEN ? { role: 'STAFF' } : null; } },
    workspaceStore: {
      async create() { creates++; return { id: '11111111-1111-4111-8111-111111111111', revision: 1 }; },
      async load() { throw new Error('not called'); },
      async save() { throw new Error('not called'); },
    },
  });
  const cookie = `${COOKIE_NAME}=${TOKEN}`;
  const body = JSON.stringify({ creationKey: CREATION_KEY, content: { notes: 'Synthetic' } });
  const postHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  try {
    for (const invalid of ['é'.repeat(43), 'A'.repeat(42) + 'é', 'A'.repeat(43), 'A'.repeat(42) + '=']) {
      const denied = await request(port, '/internal/workspaces', {
        method: 'POST', headers: { ...postHeaders, 'X-Facturations-CSRF': invalid }, body,
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, 'CSRF_FORBIDDEN');
    }
    assert.equal(creates, 0);
    assert.equal((await request(port, '/health')).status, 200);
    const csrf = await request(port, '/internal/workspaces/csrf', { headers: { Cookie: cookie } });
    assert.equal(csrf.status, 200);
    assert.match(csrf.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const created = await request(port, '/internal/workspaces', {
      method: 'POST', headers: { ...postHeaders, 'X-Facturations-CSRF': csrf.body.csrfToken }, body,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.revision, 1);
    assert.equal(creates, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
