'use strict';

// Real Chrome/Chromium submits the actual FR/EN search form to the production route
// on a disposable self-signed loopback HTTPS server. Authentication/store are synthetic:
// this is NOT a trusted-certificate, MFA, database, reverse-proxy or deployment test.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:https');
const { readFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { attachBrowserRecentWorkspaces } = require('../src/browser-recent-workspaces');
const { createStaffSessionCookie } = require('../src/staff-session-cookie');
const { WorkspaceError } = require('../src/draft-workspace-store');

const TOKEN = 'A'.repeat(43); // Synthetic cookie ONLY; no real staff identity.
const SEARCH = 'Archive_%'; // Both percent and underscore MUST be literal.
const ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVE = { id: ID, revision: 3, updatedAt: '2026-09-21T01:00:00.000Z',
  customerName: 'Archive_% <client> & fictional' };
const RECENT = Array.from({ length: 20 }, (_, index) => ({
  id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
  revision: 1, updatedAt: '2026-09-21T02:00:00.000Z',
  customerName: `Recent fictional ${String(index + 1).padStart(2, '0')}`,
}));

// Driver runs on a separate local test-only page; the actual search HTML keeps
// its restrictive CSP without any script injection or production code changes.
const DRIVER = String.raw`
(async () => {
  try {
    const language = new URL(location.href).searchParams.get('lang');
    if (!['fr', 'en'].includes(language)) throw new Error('Unknown smoke language');
    const target = '/internal/recent-workspaces?lang=' + language;
    const response = await fetch(target, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status !== 200) throw new Error('Initial list HTTP ' + response.status);
    const documentFromServer = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (documentFromServer.documentElement.lang !== language ||
        documentFromServer.querySelectorAll('.panel li').length !== 20 ||
        documentFromServer.body.textContent.includes('Archive_% <client>')) {
      throw new Error('Expected 20 recent fictional drafts before searching');
    }
    const form = documentFromServer.querySelector('form.search');
    if (!form || form.method !== 'post' || !form.action.endsWith(target)) {
      throw new Error('The actual private search form is missing');
    }
    const control = form.elements.namedItem('q');
    if (!control || control.type !== 'search') throw new Error('Search input is missing');
    const realForm = document.importNode(form, true);
    document.body.append(realForm);
    realForm.elements.namedItem('q').value = 'Archive_%';
    realForm.requestSubmit(); // Browser navigation sends a genuine form POST + Secure cookie.
  } catch (error) {
    document.documentElement.dataset.smoke = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;

function chromeBinary() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/opt/google/chrome/chrome'].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium is mandatory for this smoke test');
}

function disposableCertificate(directory) {
  const key = join(directory, 'loopback.key');
  const cert = join(directory, 'loopback.crt');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (openssl.status !== 0) throw new Error('OpenSSL is required for disposable loopback TLS');
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function runChrome(binary, url, profile, language) {
  return new Promise((resolve, reject) => {
    // Certificate bypass is confined to the test Chrome process on 127.0.0.1.
    const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
      '--window-size=500,850', '--force-device-scale-factor=1',
      '--virtual-time-budget=12000', '--dump-dom', '--user-data-dir=' + profile, url],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const timeout = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 45000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 262144) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      closed = true;
      clearTimeout(timeout);
      const expected = language === 'fr' ? 'Aperçu calculé' : 'Calculated preview';
      const passed = code === 0 && stdout.includes(`<html lang="${language}"`) &&
        stdout.includes('&lt;client&gt; &amp; fictional') && stdout.includes(expected) &&
        stdout.includes(`value="${SEARCH}"`) &&
        stdout.includes(`/internal/editor?lang=${language}&amp;id=${ID}`) &&
        !stdout.includes('Recent fictional 01') && !stdout.includes('data-smoke="failed"') &&
        !stdout.includes(TOKEN) && !stdout.includes('<script');
      if (!passed) {
        const state = stdout.match(/<html\b[^>]*>/i)?.[0] || 'no HTML';
        return reject(new Error(`Private search Chrome ${language} failed (exit ${code}): ${state}; ${stderr.slice(-300)}`));
      }
      resolve();
    });
  });
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'facturations-search-chrome-'));
  let server;
  try {
    server = createServer(disposableCertificate(directory), (request, response) => {
      const url = new URL(request.url, 'https://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/smoke-start' &&
          ['fr', 'en'].includes(url.searchParams.get('lang')) && url.searchParams.size === 1) {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'Set-Cookie': createStaffSessionCookie(TOKEN),
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'",
        });
        response.end('<!doctype html><html lang="en"><head><script src="/smoke-driver.js" defer></script></head><body></body></html>');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/smoke-driver.js' && !url.search) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(DRIVER);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `https://127.0.0.1:${server.address().port}`;
    const calls = [];
    attachBrowserRecentWorkspaces(server, { origin, recentStore: {
      async list({ token, query }) {
        if (token !== TOKEN) throw new WorkspaceError('UNAUTHORIZED', 401);
        assert.ok(query === '' || query === SEARCH, 'Unexpected synthetic search');
        calls.push(query);
        return { status: 'WORKSPACES_ONLY', workspaces: query === SEARCH ? [ARCHIVE] : RECENT };
      },
    } });
    const binary = chromeBinary();
    for (const language of ['fr', 'en']) {
      const profile = join(directory, 'chrome-' + language);
      await runChrome(binary, `${origin}/smoke-start?lang=${language}`, profile, language);
    }
    assert.deepEqual(calls, ['', SEARCH, '', SEARCH], 'Both browsers must list and POST search');
    console.log('PASS: real Chromium FR/EN submitted private search forms on disposable loopback HTTPS; archived draft found and escaped.');
    console.log('Scope: synthetic staff store and test cookie, self-signed TLS with test-only Chrome bypass; no MFA, real PostgreSQL, staging or external provider.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
