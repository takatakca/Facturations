'use strict';

// Fully synthetic, local TLS + real Chrome + actual routes + disposable PostgreSQL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { Pool } = require('pg');
const { createServer } = require('../src/server');
const { attachBrowserStaffLogin } = require('../src/browser-staff-login');
const { attachBrowserWorkspaceRoutes } = require('../src/browser-workspace-routes');
const { attachBrowserWorkspaceEditor, renderEditor } = require('../src/browser-workspace-editor');
const { attachBrowserWorkspacePreview } = require('../src/browser-workspace-preview');
const { attachBrowserWorkspaceSubmission } = require('../src/browser-workspace-submission');
const { attachBrowserOwnerReview } = require('../src/browser-owner-review');
const { attachBrowserOwnerPrint } = require('../src/browser-owner-print');
const { attachReadOnlyDashboardCookie } = require('../src/browser-dashboard-session');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');
const { createLoginAttemptLimit } = require('../src/login-attempt-limit');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createWorkspaceSubmissionStore } = require('../src/workspace-submission-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createDashboardStore } = require('../src/dashboard-store');
const { loginDriver, editorDriver } = require('./owner-review-chrome-drivers');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-review-password-2026!';
const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function disposableOnly() {
  if (!DATABASE) throw Error('Disposable test database is required');
  const url = new URL(DATABASE);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/facturations_test' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) || process.env.FACTURATIONS_DATABASE_URL ||
      process.env.WAVE_ACCESS_TOKEN || process.env.FACTURATIONS_PUBLIC_ORIGIN ||
      process.env.TAKATAK_ADMIN_KEY) throw Error('Refusing external or production credentials');
}
function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const char of value) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw Error('Invalid test MFA secret');
    buffer = (buffer << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}
function certificate(directory) {
  const key = join(directory, 'local.key'), cert = join(directory, 'local.crt');
  const created = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (created.status !== 0) throw Error('OpenSSL required for disposable local HTTPS');
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
function chromeBinary() {
  for (const file of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/opt/google/chrome/chrome'].filter(Boolean)) if (existsSync(file)) return file;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw Error('Chrome/Chromium required, cannot skip');
}
function fixture(res, type, body) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': POLICY });
  res.end(body);
}
function runChrome(binary, url, profile, lang) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
      '--virtual-time-budget=42000', '--dump-dom', '--window-size=500,850',
      '--user-data-dir=' + profile, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', closed = false;
    const timeout = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 90000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8');
      if (output.length > 262144) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-600); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      closed = true; clearTimeout(timeout);
      if (code !== 0 || !output.includes(`<html lang="${lang}"`) ||
          !output.includes('data-complete-owner-journey="passed"') ||
          output.includes('data-complete-owner-journey="failed"') || output.includes(PASSWORD)) {
        const state = output.match(/<html\b[^>]*>/i)?.[0] || 'missing browser state';
        return reject(Error(`Chrome full owner journey ${lang}: exit=${code}; ${state}; ${errors.slice(-100)}`));
      }
      resolve();
    });
  });
}
async function main() {
  disposableOnly();
  const pool = new Pool({ connectionString: DATABASE, max: 6, connectionTimeoutMillis: 5000 });
  const directory = mkdtempSync(join(tmpdir(), 'facturations-owner-review-'));
  let server;
  try {
    const businessId = 'owner-journey-' + crypto.randomUUID();
    const email = 'owner-' + crypto.randomUUID() + '@example.test';
    const encryptionKeyHex = crypto.randomBytes(32).toString('hex');
    let clock = 59000;
    const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex, now: () => clock });
    const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
    const attempts = createLoginAttemptLimit({ pool, businessId });
    const workspaces = createDraftWorkspaceStore({ pool, businessId });
    const drafts = createDraftStore({ pool, businessId });
    const approvals = createDraftApprovalStore({ pool, businessId });
    const submissions = createWorkspaceSubmissionStore({ pool, businessId });
    const dashboard = createDashboardStore({ pool, businessId });
    const owner = await auth.createPendingStaff({ email, password: PASSWORD, role: 'OWNER' });
    // Trusted synthetic fixture only, never a user-facing email-verification shortcut.
    await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
      [businessId, owner.id]);
    const { secretBase32 } = await totp.provisionTrusted(owner.id);
    const secret = base32Decode(secretBase32);
    assert.equal(await totp.confirmTrusted(owner.id, oneTimeCode(secret, 1)), true);
    const codes = { fr: oneTimeCode(secret, 4), en: oneTimeCode(secret, 6) };
    const app = createServer({ config: { businessId, adminKey: 'fictional-fixture-only', waveToken: null },
      staffAuthStore: auth, dashboardStore: dashboard });
    const applicationHandler = app.listeners('request')[0];
    server = https.createServer(certificate(directory), (req, res) => {
      const url = new URL(req.url, 'https://127.0.0.1');
      const lang = url.searchParams.get('lang');
      const synthetic = ['fr', 'en'].includes(lang) && url.searchParams.size === 1 && req.method === 'GET';
      if (synthetic && url.pathname === '/smoke-login') return fixture(res, 'text/html; charset=utf-8',
        `<!doctype html><html lang="${lang}"><head><script src="/smoke-login-driver.js?lang=${lang}" defer></script></head><body></body></html>`);
      if (synthetic && url.pathname === '/smoke-login-driver.js') return fixture(res, 'text/javascript; charset=utf-8',
        loginDriver(lang, email, PASSWORD, codes[lang]));
      if (synthetic && url.pathname === '/smoke-editor') return fixture(res, 'text/html; charset=utf-8',
        renderEditor(lang).replace('</head>', `<script src="/smoke-editor-driver.js?lang=${lang}" defer></script></head>`));
      if (synthetic && url.pathname === '/smoke-editor-driver.js') return fixture(res, 'text/javascript; charset=utf-8',
        editorDriver(lang));
      return applicationHandler(req, res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `https://127.0.0.1:${server.address().port}`;
    attachBrowserStaffLogin(server, { origin, staffAuthStore: auth, attemptLimit: attempts });
    attachBrowserWorkspaceRoutes(server, { origin, encryptionKeyHex,
      staffAuthStore: auth, workspaceStore: workspaces });
    attachBrowserWorkspaceEditor(server, { origin, staffAuthStore: auth });
    attachBrowserWorkspacePreview(server, { origin, workspaceStore: workspaces, staffAuthStore: auth });
    attachBrowserWorkspaceSubmission(server, { origin, encryptionKeyHex, businessId,
      staffAuthStore: auth, workspaceStore: workspaces, submissionStore: submissions });
    attachBrowserOwnerReview(server, { origin, encryptionKeyHex, businessId,
      staffAuthStore: auth, dashboardStore: dashboard, draftStore: drafts, approvalStore: approvals });
    attachBrowserOwnerPrint(server, { origin, businessId,
      staffAuthStore: auth, draftStore: drafts, approvalStore: approvals });
    attachReadOnlyDashboardCookie(server);
    const binary = chromeBinary();
    for (const [lang, time] of [['fr', 149000], ['en', 209000]]) {
      clock = time;
      await runChrome(binary, origin + '/smoke-login?lang=' + lang,
        join(directory, 'chrome-' + lang), lang);
    }
    const results = await Promise.all([
      pool.query('SELECT revision FROM facturations_draft_workspaces WHERE business_id=$1', [businessId]),
      pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1', [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_workspace_submissions WHERE business_id=$1', [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1', [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM invoice_audit_events WHERE business_id=$1 AND action=$2',
        [businessId, 'DRAFT_CREATED']),
    ]);
    assert.equal(results[0].rows.length, 2);
    assert.ok(results[0].rows.every(row => row.revision === 2));
    assert.deepEqual(results[1].rows.map(row => row.status), ['DRAFT', 'DRAFT']);
    for (let i = 2; i < 5; i++) assert.equal(results[i].rows[0].n, 2);
    console.log('PASS: real Chrome FR/EN + MFA + autosave + explicit immutable submission + separate internal approval + unissued print.');
    console.log('Scope: fictional identities, disposable PostgreSQL, self-signed local HTTPS; no Wave, issuance, email or staging.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
