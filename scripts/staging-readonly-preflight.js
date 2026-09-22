'use strict';

// Manual, read-only preflight for the ONE isolated Facturations staging hostname.
// Never supply cookies, tokens, customer details or administrative credentials.
const https = require('node:https');
const TARGET = 'https://facturations.bolon.ca';
const PATHS = Object.freeze(['/health', '/internal/login?lang=fr',
  '/internal/recent-workspaces?lang=fr', '/internal/workspaces/csrf']);
const MAX_BYTES = 24576;

function assertTarget(value) {
  if (value !== TARGET) throw new Error('Only the isolated Facturations staging origin is permitted');
  return new URL(value);
}

function checkResults(responses, now = Date.now()) {
  if (!Array.isArray(responses) || responses.length !== PATHS.length ||
      !Number.isFinite(now)) throw new Error('Incomplete staging evidence');
  const [health, login, recent, csrf] = responses;
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    if (!response || response.path !== PATHS[i] || !Number.isInteger(response.status) ||
        !response.headers || typeof response.headers !== 'object' ||
        typeof response.body !== 'string' || !response.tls ||
        response.tls.authorized !== true || !Number.isFinite(response.tls.expiresAt) ||
        response.tls.expiresAt - now < 86400000) {
      throw new Error(`TLS or response evidence invalid for ${PATHS[i]}`);
    }
    if (response.headers.location || response.headers['access-control-allow-origin'] ||
        response.headers['x-powered-by']) {
      throw new Error(`Redirect or avoidable header on ${PATHS[i]}`);
    }
    const hsts = response.headers['strict-transport-security'];
    const maxAge = typeof hsts === 'string' ? /(?:^|;)\s*max-age=(\d+)(?:\s*;|\s*$)/i.exec(hsts) : null;
    if (!maxAge || Number(maxAge[1]) < 15552000) {
      throw new Error(`HTTPS strict transport policy missing on ${PATHS[i]}`);
    }
    if (response.headers['x-content-type-options'] !== 'nosniff' ||
        response.headers['referrer-policy'] !== 'no-referrer') {
      throw new Error(`Required security headers missing on ${PATHS[i]}`);
    }
  }
  if (health.status !== 200 || !/^application\/json\b/i.test(health.headers['content-type'] || '') ||
      health.headers['cache-control'] !== 'no-store') throw new Error('Health endpoint is not the expected process');
  let healthPayload;
  try { healthPayload = JSON.parse(health.body); } catch { throw new Error('Invalid health response'); }
  if (healthPayload?.ok !== true || healthPayload.service !== 'takatak-wave') {
    throw new Error('Unexpected application identity at staging hostname');
  }
  if (login.status !== 200 || !/^text\/html\b/i.test(login.headers['content-type'] || '') ||
      login.headers['cache-control'] !== 'private, no-store' ||
      !login.body.includes('<html lang="fr"') || !login.body.includes('name="password"') ||
      !login.body.includes('name="code"') ||
      !String(login.headers['content-security-policy'] || '').includes("form-action 'self'") ||
      login.headers['x-frame-options'] !== 'DENY') {
    throw new Error('French MFA sign-in surface or security policy unavailable');
  }
  for (const response of [recent, csrf]) {
    if (response.status !== 401 || response.headers['cache-control'] !== 'private, no-store' ||
        response.headers['x-frame-options'] !== 'DENY' ||
        !String(response.headers['content-security-policy'] || '').includes("default-src 'none'")) {
      throw new Error(`Private route did not deny anonymous access: ${response.path}`);
    }
  }
  return Object.freeze({ passed: true, checks: PATHS.length, origin: TARGET });
}

function readOnlyGet(path) {
  if (!PATHS.includes(path)) return Promise.reject(new Error('Unapproved path'));
  const origin = assertTarget(TARGET);
  return new Promise((resolve, reject) => {
    let finished = false;
    const req = https.request({ hostname: origin.hostname, port: 443, path, method: 'GET',
      agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
      headers: { Accept: 'text/html, application/json', 'Cache-Control': 'no-store',
        'User-Agent': 'GROUPE-TAKATAK-Facturations-readonly-preflight/1' } }, response => {
      const chunks = [];
      let bytes = 0;
      const socket = response.socket;
      const cert = socket.getPeerCertificate();
      const evidence = { authorized: socket.authorized === true,
        expiresAt: Date.parse(cert.valid_to || '') };
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) req.destroy(new Error('Staging response exceeds safe bound'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (finished) return;
        finished = true;
        resolve({ path, status: response.statusCode, headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'), tls: evidence });
      });
      response.on('error', error => { if (!finished) { finished = true; reject(error); } });
    });
    req.setTimeout(8000, () => req.destroy(new Error('Staging HTTPS request timeout')));
    req.on('error', error => { if (!finished) { finished = true; reject(error); } });
    req.end();
  });
}

async function main() {
  assertTarget(process.argv[2]); // An explicit, exact staging origin is mandatory.
  const results = [];
  for (const path of PATHS) results.push(await readOnlyGet(path));
  const summary = checkResults(results);
  console.log(`PASS: ${summary.checks} anonymous read-only HTTPS checks for ${summary.origin}`);
  console.log('This is NOT approval to deploy, process real data or issue invoices.');
}

if (require.main === module) {
  main().catch(error => {
    // Never print response bodies, headers, URLs with queries or connection details.
    console.error('FAIL: staging read-only preflight — ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { TARGET, PATHS, assertTarget, checkResults, readOnlyGet };
