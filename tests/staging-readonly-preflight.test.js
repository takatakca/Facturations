'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGET, PATHS, assertTarget, checkResults, readOnlyGet } =
  require('../scripts/staging-readonly-preflight');

const NOW = Date.parse('2026-09-21T23:00:00Z');
const security = Object.freeze({
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
});
function fixtures() {
  const tls = { authorized: true, expiresAt: NOW + 30 * 86400000 };
  return [
    { path: PATHS[0], status: 200, tls, headers: {
      ...security, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    }, body: JSON.stringify({ ok: true, service: 'takatak-wave', phase: 3 }) },
    { path: PATHS[1], status: 200, tls, headers: {
      ...security, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    }, body: JSON.stringify({ ok: true, service: 'takatak-wave', readiness: 'ready' }) },
    { path: PATHS[2], status: 200, tls, headers: {
      ...security, 'content-type': 'text/html; charset=utf-8',
    }, body: '<!doctype html><html lang="fr"><input name="password"><input name="code"></html>' },
    { path: PATHS[3], status: 401, tls, headers: { ...security }, body: 'Unauthorized' },
    { path: PATHS[4], status: 401, tls, headers: { ...security }, body: '{"error":"UNAUTHORIZED"}' },
  ];
}

test('manual target is the exact isolated HTTPS origin and request paths are fixed', async () => {
  assert.equal(assertTarget(TARGET).hostname, 'facturations.bolon.ca');
  for (const other of ['http://facturations.bolon.ca', 'https://takatak.ca',
    'https://facturations.bolon.ca/', 'https://facturations.bolon.ca:8443',
    'https://facturations.bolon.ca@evil.example.test', undefined]) {
    assert.throws(() => assertTarget(other), /Only the isolated/);
  }
  assert.deepEqual(PATHS, ['/health', '/ready', '/internal/login?lang=fr',
    '/internal/recent-workspaces?lang=fr', '/internal/workspaces/csrf']);
  await assert.rejects(readOnlyGet('/internal/workspaces'), /Unapproved path/);
});

test('accepts only verified HTTPS, the expected app and anonymous read-only denials', () => {
  assert.deepEqual(checkResults(fixtures(), NOW), { passed: true, checks: 5, origin: TARGET });
});

test('fails closed on TLS problems, redirects, unprotected routes and missing security headers', () => {
  const cases = [
    [0, item => { item.tls = { authorized: false, expiresAt: NOW + 86400000 * 30 }; }],
    [0, item => { item.tls = { authorized: true, expiresAt: NOW + 1000 }; }],
    [0, item => { item.status = 301; item.headers.location = 'https://other.example.test'; }],
    [0, item => { item.body = '{"ok":true,"service":"other-service"}'; }],
    [0, item => { item.headers['strict-transport-security'] = 'max-age=0'; }],
    [1, item => { item.status = 503; item.body = '{"ok":false,"service":"takatak-wave","readiness":"unavailable"}'; }],
    [2, item => { item.body = '<html lang="fr">Not the MFA login form</html>'; }],
    [2, item => { delete item.headers['content-security-policy']; }],
    [3, item => { item.status = 200; }],
    [4, item => { item.headers['access-control-allow-origin'] = '*'; }],
    [4, item => { item.headers['x-powered-by'] = 'Express'; }],
  ];
  for (const [index, mutate] of cases) {
    const data = fixtures();
    mutate(data[index]);
    assert.throws(() => checkResults(data, NOW));
  }
  assert.throws(() => checkResults(fixtures().slice(1), NOW), /Incomplete/);
});
