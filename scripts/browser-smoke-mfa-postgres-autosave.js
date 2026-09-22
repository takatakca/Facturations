'use strict';

// Real Chrome + real MFA/session/CSRF/workspace routes + DISPOSABLE PostgreSQL only.
// The fixture pages exist only in this test; they reuse the real editor HTML and client.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { Pool } = require('pg');
const { createServer: createApp } = require('../src/server');
const { attachBrowserStaffLogin } = require('../src/browser-staff-login');
const { attachBrowserWorkspaceRoutes } = require('../src/browser-workspace-routes');
const { attachBrowserWorkspaceEditor, renderEditor } = require('../src/browser-workspace-editor');
const { attachReadOnlyDashboardCookie } = require('../src/browser-dashboard-session');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');
const { createLoginAttemptLimit } = require('../src/login-attempt-limit');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createDashboardStore } = require('../src/dashboard-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-only-Strong-password-2026!';
// PostgreSQL orders the synthetic emails lexicographically: autosave-en precedes autosave-fr.
const LANGUAGES = Object.freeze(['en', 'fr']);

function requireDisposableDatabase() {
  if (!DATABASE) throw new Error('Disposable FACTURATIONS_TEST_DATABASE_URL required');
  const url = new URL(DATABASE);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/facturations_test' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      process.env.FACTURATIONS_DATABASE_URL || process.env.WAVE_ACCESS_TOKEN ||
      process.env.FACTURATIONS_PUBLIC_ORIGIN || process.env.TAKATAK_ADMIN_KEY) {
    throw new Error('Refusing non-test database or configured provider/production environment');
  }
}
function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid synthetic MFA secret');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}
function localCertificate(directory) {
  const key = join(directory, 'local.key'), cert = join(directory, 'local.crt');
  const done = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error('OpenSSL required for disposable local TLS');
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
function chromeBinary() {
  for (const file of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/opt/google/chrome/chrome'].filter(Boolean)) if (existsSync(file)) return file;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium required; never silently skip');
}
const POLICY = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function send(res, type, body) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': POLICY });
  res.end(body);
}
function loginDriver(language, email, code) {
  return String.raw`
(async () => {
  try {
    const lang = ${JSON.stringify(language)};
    if ((await fetch('/internal/workspaces/csrf', {credentials:'same-origin'})).status !== 401)
      throw Error('Private workspace accessible before login');
    const loginPage = await fetch('/internal/login?lang=' + lang, {credentials:'same-origin'});
    const login = new DOMParser().parseFromString(await loginPage.text(), 'text/html');
    if (loginPage.status !== 200 || login.documentElement.lang !== lang ||
        !login.querySelector('input[name="code"]') || !login.querySelector('input[name="password"]'))
      throw Error('Actual MFA form unavailable');
    const result = await fetch('/internal/login?lang=' + lang, {
      method:'POST', credentials:'same-origin', redirect:'follow',
      body:new URLSearchParams({email:${JSON.stringify(email)},password:${JSON.stringify(PASSWORD)},code:${JSON.stringify(code)}})
    });
    if (result.status !== 200 || new URL(result.url).pathname !== '/internal/dashboard')
      throw Error('Actual MFA login did not open dashboard');
    if (document.cookie.includes('__Host-facturations-session'))
      throw Error('HttpOnly cookie was readable by JavaScript');
    location.replace('/smoke-editor?lang=' + lang);
  } catch (error) {
    document.documentElement.dataset.integratedAutosave = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;
}
function editorDriver(language) {
  return String.raw`
(async () => {
  const lang = ${JSON.stringify(language)};
  const get = id => document.getElementById(id);
  const wait = async (condition, label) => {
    for (let attempt = 0; attempt < 360; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('Timed out: ' + label);
  };
  const edit = (id, value) => {
    get(id).value = value;
    get(id).dispatchEvent(new Event('input', {bubbles:true}));
  };
  try {
    await wait(() => !get('editing-fields').disabled && !get('save').disabled, 'private editor ready');
    if (!get('preview').hidden) throw Error('Preview visible before save');
    edit('customer', 'Integrated fictional ' + lang);
    edit('email', 'autosave-' + lang + '@example.test');
    edit('line-1-description', 'Fictional service');
    edit('line-1-quantity', '2');
    edit('line-1-price', '12,50');
    // Never click Save, requestSubmit or write directly from this driver.
    await wait(() => !get('preview').hidden &&
      get('status').textContent.includes(lang === 'fr' ? 'Révision 1' : 'Revision 1'), 'automatic creation');
    const link = new URL(get('preview').href);
    if (!/^\/internal\/workspaces\/[a-f0-9-]{36}\/preview$/.test(link.pathname) ||
        link.searchParams.get('lang') !== lang) throw Error('Saved preview link is invalid');
    const workspace = link.pathname.split('/')[3];
    const first = await fetch('/internal/workspaces/' + workspace, {credentials:'same-origin',cache:'no-store'});
    const firstRow = await first.json();
    if (first.status !== 200 || firstRow.revision !== 1 ||
        firstRow.content.customer.email !== 'autosave-' + lang + '@example.test' ||
        firstRow.content.lines[0].unitPriceCents !== 1250) throw Error('First revision not persisted');
    edit('notes', 'Second integrated fictional revision ' + lang);
    if (!get('preview').hidden) throw Error('Stale preview stayed visible after editing');
    await wait(() => !get('preview').hidden &&
      get('status').textContent.includes(lang === 'fr' ? 'Révision 2' : 'Revision 2'), 'automatic revision');
    const second = await fetch('/internal/workspaces/' + workspace, {credentials:'same-origin',cache:'no-store'});
    const final = await second.json();
    if (second.status !== 200 || final.revision !== 2 ||
        final.content.notes !== 'Second integrated fictional revision ' + lang ||
        final.content.lines[0].unitPriceCents !== 1250) throw Error('Second revision was not preserved');
    if (document.cookie.includes('__Host-facturations-session')) throw Error('Session cookie readable');
    document.documentElement.dataset.integratedAutosave = 'passed';
  } catch (error) {
    document.documentElement.dataset.integratedAutosave = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;
}
function runChrome(binary, url, profile, language) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
      '--virtual-time-budget=26000', '--dump-dom', '--window-size=500,850',
      '--user-data-dir=' + profile, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', closed = false;
    const timeout = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 60000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 262144) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-1000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      closed = true; clearTimeout(timeout);
      if (code !== 0 || !output.includes(`<html lang="${language}"`) ||
          !/data-integrated-autosave="passed"/.test(output) ||
          output.includes(PASSWORD) || output.includes('data-integrated-autosave="failed"')) {
        const state = output.match(/<html\b[^>]*>/i)?.[0] || 'no HTML state';
        return reject(Error(`Integrated Chrome autosave ${language} failed (exit ${code}): ${state}; ${errors.slice(-200)}`));
      }
      resolve();
    });
  });
}
async function main() {
  requireDisposableDatabase();
  const pool = new Pool({ connectionString: DATABASE, max: 6, connectionTimeoutMillis: 5000 });
  const directory = mkdtempSync(join(tmpdir(), 'facturations-mfa-autosave-'));
  let server;
  try {
    const businessId = 'autosave-pg-' + crypto.randomUUID();
    const email = 'owner-' + crypto.randomUUID() + '@example.test';
    let clock = 59000;
    const encryptionKeyHex = crypto.randomBytes(32).toString('hex');
    const totp = createStaffTotpStore({ pool, businessId, encryptionKeyHex, now: () => clock });
    const auth = createStaffAuthStore({ pool, businessId, totpStore: totp });
    const limit = createLoginAttemptLimit({ pool, businessId });
    const workspaces = createDraftWorkspaceStore({ pool, businessId });
    const dashboard = createDashboardStore({ pool, businessId });
    const member = await auth.createPendingStaff({ email, password: PASSWORD, role: 'OWNER' });
    await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
      [businessId, member.id]); // Trusted test fixture only; no public verification bypass.
    const { secretBase32 } = await totp.provisionTrusted(member.id);
    const secret = decodeBase32(secretBase32);
    assert.equal(await totp.confirmTrusted(member.id, oneTimeCode(secret, 1)), true);
    const app = createApp({ config: { businessId, adminKey: 'synthetic-admin-key-solely-for-fixture',
      waveToken: null }, staffAuthStore: auth, dashboardStore: dashboard });
    const applicationHandler = app.listeners('request')[0];
    const codes = { fr: oneTimeCode(secret, 4), en: oneTimeCode(secret, 6) };
    server = https.createServer(localCertificate(directory), (req, res) => {
      const url = new URL(req.url, 'https://127.0.0.1');
      const lang = url.searchParams.get('lang');
      const fixture = ['fr', 'en'].includes(lang) && url.searchParams.size === 1;
      if (req.method === 'GET' && fixture && url.pathname === '/smoke-login') {
        return send(res, 'text/html; charset=utf-8',
          `<!doctype html><html lang="${lang}"><head><script src="/smoke-login-driver.js?lang=${lang}" defer></script></head><body></body></html>`);
      }
      if (req.method === 'GET' && fixture && url.pathname === '/smoke-login-driver.js') {
        return send(res, 'text/javascript; charset=utf-8', loginDriver(lang, email, codes[lang]));
      }
      if (req.method === 'GET' && fixture && url.pathname === '/smoke-editor') {
        return send(res, 'text/html; charset=utf-8', renderEditor(lang)
          .replace('</head>', `<script src="/smoke-editor-driver.js?lang=${lang}" defer></script></head>`));
      }
      if (req.method === 'GET' && fixture && url.pathname === '/smoke-editor-driver.js') {
        return send(res, 'text/javascript; charset=utf-8', editorDriver(lang));
      }
      return applicationHandler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `https://127.0.0.1:${server.address().port}`;
    attachBrowserStaffLogin(server, { origin, staffAuthStore: auth, attemptLimit: limit });
    attachBrowserWorkspaceRoutes(server, { origin, encryptionKeyHex,
      staffAuthStore: auth, workspaceStore: workspaces });
    attachBrowserWorkspaceEditor(server, { origin, staffAuthStore: auth });
    attachReadOnlyDashboardCookie(server);
    const binary = chromeBinary();
    for (const [lang, time] of [['fr', 149000], ['en', 209000]]) {
      clock = time;
      await runChrome(binary, origin + '/smoke-login?lang=' + lang,
        join(directory, 'chrome-' + lang), lang);
      await assert.rejects(auth.authenticateWithTotp({ email, password: PASSWORD, code: codes[lang] }),
        error => error instanceof StaffAuthError && error.code === 'INVALID_CREDENTIALS');
    }
    const [drafts, invoices, sessions] = await Promise.all([
      pool.query(`SELECT owner_staff_id, revision, content FROM facturations_draft_workspaces
                   WHERE business_id=$1 ORDER BY content->'customer'->>'email'`, [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_staff_sessions WHERE business_id=$1', [businessId]),
    ]);
    assert.equal(drafts.rows.length, 2, 'One autosaved workspace per browser language');
    assert.equal(sessions.rows[0].n, 2, 'Two independently verified browser sessions');
    assert.equal(invoices.rows[0].n, 0, 'No official invoice draft created');
    for (const [index, lang] of LANGUAGES.entries()) {
      const row = drafts.rows[index];
      assert.equal(row.owner_staff_id, member.id);
      assert.equal(row.revision, 2);
      assert.equal(row.content.customer.email, 'autosave-' + lang + '@example.test');
      assert.equal(row.content.notes, 'Second integrated fictional revision ' + lang);
      assert.equal(row.content.lines[0].unitPriceCents, 1250);
    }
    console.log('PASS: Chrome FR/EN → actual MFA → Secure/HttpOnly cookie → CSRF → automatic create/update → disposable PostgreSQL revision 2.');
    console.log('Scope: local self-signed HTTPS and fictional example.test identities only. No staging, Wave, invoices or email.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
