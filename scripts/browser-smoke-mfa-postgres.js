'use strict';

// Real Chrome, actual login/routes and disposable PostgreSQL; NEVER a staging or production test.
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
const { attachBrowserRecentWorkspaces } = require('../src/browser-recent-workspaces');
const { attachReadOnlyDashboardCookie } = require('../src/browser-dashboard-session');
const { createStaffAuthStore, StaffAuthError } = require('../src/staff-auth-store');
const { createStaffTotpStore, oneTimeCode } = require('../src/staff-totp-store');
const { createLoginAttemptLimit } = require('../src/login-attempt-limit');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createRecentWorkspaceStore } = require('../src/recent-workspace-store');
const { createDashboardStore } = require('../src/dashboard-store');

const DB = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-only-Strong-password-2026!';
const SEARCH = 'Archive_%';
function checkIsolation() {
  if (!DB) throw new Error('Disposable FACTURATIONS_TEST_DATABASE_URL required');
  const url = new URL(DB);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/facturations_test' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) || process.env.FACTURATIONS_DATABASE_URL ||
      process.env.WAVE_ACCESS_TOKEN || process.env.FACTURATIONS_PUBLIC_ORIGIN || process.env.TAKATAK_ADMIN_KEY) {
    throw new Error('Refusing non-test database or configured provider/production environment');
  }
}
function decodeBase32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let value = 0, bits = 0;
  const bytes = [];
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid synthetic MFA secret');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}
function certificate(dir) {
  const key = join(dir, 'local.key'), cert = join(dir, 'local.crt');
  const done = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error('OpenSSL required for local ephemeral TLS');
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
function chromeBinary() {
  for (const path of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/opt/google/chrome/chrome'].filter(Boolean)) if (existsSync(path)) return path;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium required; no silent skip');
}
// Test driver lives ONLY on a special fixture page. Real login/dashboard/search keep their CSP.
function driver(language, email, code) {
  return String.raw`
(async () => {
  const lang = ${JSON.stringify(language)};
  try {
    const login = await fetch('/internal/login?lang=' + lang, {credentials:'same-origin',cache:'no-store'});
    if (login.status !== 200) throw Error('Login page denied');
    const page = new DOMParser().parseFromString(await login.text(), 'text/html');
    const form = page.querySelector('form');
    if (page.documentElement.lang !== lang || !form || form.method !== 'post' ||
        !form.getAttribute('action').endsWith('/internal/login?lang=' + lang) ||
        !form.elements.namedItem('email') || !form.elements.namedItem('password') ||
        !form.elements.namedItem('code')) throw Error('Actual login form missing');
    if ((await fetch('/internal/recent-workspaces?lang=' + lang,{credentials:'same-origin'})).status !== 401)
      throw Error('Private drafts accessible before MFA');
    const auth = await fetch('/internal/login?lang=' + lang, {
      method:'POST', credentials:'same-origin', redirect:'follow',
      body:new URLSearchParams({email:${JSON.stringify(email)},password:${JSON.stringify(PASSWORD)},code:${JSON.stringify(code)}})
    });
    if (auth.status !== 200 || new URL(auth.url).pathname !== '/internal/dashboard')
      throw Error('Actual MFA login did not open dashboard');
    const dashboard = await auth.text();
    if (!dashboard.includes(lang === 'fr' ? 'Tableau de bord' : 'Dashboard') ||
        !dashboard.includes('/internal/recent-workspaces?lang=' + lang))
      throw Error('Authenticated dashboard/navigation missing');
    if (document.cookie.includes('__Host-facturations-session'))
      throw Error('HttpOnly cookie accessible to JavaScript');
    const target = '/internal/recent-workspaces?lang=' + lang;
    const listing = await fetch(target,{credentials:'same-origin',cache:'no-store'});
    if (listing.status !== 200) throw Error('Recent drafts inaccessible after MFA');
    const recent = new DOMParser().parseFromString(await listing.text(),'text/html');
    if (recent.documentElement.lang !== lang || recent.querySelectorAll('.panel li').length !== 20 ||
        recent.body.textContent.includes('Archive_% <client>'))
      throw Error('Expected 20 newer fictional drafts');
    const search = recent.querySelector('form.search');
    if (!search || search.method !== 'post' || !search.action.endsWith(target))
      throw Error('Actual private search form missing');
    const realForm = document.importNode(search,true);
    document.body.append(realForm);
    realForm.elements.namedItem('q').value = 'Archive_%';
    realForm.requestSubmit();
  } catch(error) {
    document.documentElement.dataset.smoke = 'failed';
    document.documentElement.dataset.smokeError = error.message;
  }
})();`;
}
function runChrome(bin, url, dir, language, id) {
  return new Promise((resolve,reject) => {
    const child = spawn(bin,['--headless=new','--no-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-extensions','--disable-background-networking',
      '--no-first-run','--no-default-browser-check','--ignore-certificate-errors',
      '--window-size=500,850','--virtual-time-budget=24000','--dump-dom',
      '--user-data-dir='+dir,url],{stdio:['ignore','pipe','pipe']});
    let out = '', err = '', closed = false;
    const timeout = setTimeout(() => {if(!closed) child.kill('SIGKILL');},60000);
    child.stdout.on('data',chunk => {out += chunk.toString('utf8'); if(out.length>262144) child.kill('SIGKILL');});
    child.stderr.on('data',chunk => {err=(err+chunk.toString('utf8')).slice(-1500);});
    child.on('error',error => {clearTimeout(timeout);reject(error);});
    child.on('close',code => {
      closed = true; clearTimeout(timeout);
      const expected = language === 'fr' ? 'Aperçu calculé' : 'Calculated preview';
      if (code !== 0 || !out.includes(`<html lang="${language}"`) ||
          !out.includes('&lt;client&gt; &amp; fictional') || !out.includes(expected) ||
          !out.includes(`value="${SEARCH}"`) ||
          !out.includes(`/internal/editor?lang=${language}&amp;id=${id}`) ||
          (out.match(/<li>/g)||[]).length !== 1 || out.includes('Recent fictional 01') ||
          out.includes('data-smoke="failed"') || out.includes(PASSWORD) || out.includes('<script')) {
        const state = out.match(/<html\b[^>]*>/i)?.[0] || 'no HTML';
        return reject(Error(`Integrated Chrome ${language} failed (exit ${code}): ${state}; ${err.slice(-200)}`));
      }
      resolve();
    });
  });
}
async function main() {
  checkIsolation();
  const pool = new Pool({connectionString:DB,max:6,connectionTimeoutMillis:5000});
  const directory = mkdtempSync(join(tmpdir(),'facturations-mfa-pg-'));
  let server;
  try {
    const businessId = 'browser-pg-' + crypto.randomUUID();
    const email = 'owner-' + crypto.randomUUID() + '@example.test';
    let clock = 59000;
    const totp = createStaffTotpStore({pool,businessId,
      encryptionKeyHex:crypto.randomBytes(32).toString('hex'),now:()=>clock});
    const auth = createStaffAuthStore({pool,businessId,totpStore:totp});
    const limiter = createLoginAttemptLimit({pool,businessId});
    const workspaces = createDraftWorkspaceStore({pool,businessId});
    const recent = createRecentWorkspaceStore({pool,businessId});
    const dashboard = createDashboardStore({pool,businessId});
    const member = await auth.createPendingStaff({email,password:PASSWORD,role:'OWNER'});
    await pool.query('UPDATE facturations_staff_users SET email_verified_at=now() WHERE business_id=$1 AND id=$2',
      [businessId,member.id]); // Trusted fixture only; not a user-facing verification bypass.
    const {secretBase32} = await totp.provisionTrusted(member.id);
    const secret = decodeBase32(secretBase32);
    assert.equal(await totp.confirmTrusted(member.id,oneTimeCode(secret,1)),true);
    clock = 89000;
    const seeded = await auth.authenticateWithTotp({email,password:PASSWORD,code:oneTimeCode(secret,2)});
    const save = name => workspaces.create({token:seeded.token,creationKey:crypto.randomBytes(16).toString('hex'),
      content:{currency:'CAD',customer:{name},notes:'Private fictional notes'}});
    const archived = await save('Archive_% <client> & fictional');
    for (let n=1;n<=21;n++) await save('Recent fictional '+String(n).padStart(2,'0'));
    assert.equal((await recent.list({token:seeded.token})).workspaces.length,20);
    assert.deepEqual((await recent.list({token:seeded.token,query:SEARCH})).workspaces.map(x=>x.id),[archived.id]);
    const app = createApp({config:{businessId,adminKey:'synthetic-private-admin-key-for-test-only',waveToken:null},
      staffAuthStore:auth,dashboardStore:dashboard});
    const handler = app.listeners('request')[0];
    const codes = {fr:oneTimeCode(secret,4),en:oneTimeCode(secret,6)};
    server = https.createServer(certificate(directory),(req,res)=>{
      const url = new URL(req.url,'https://127.0.0.1');
      const lang = url.searchParams.get('lang');
      if (req.method==='GET' && url.pathname==='/smoke-start' &&
          ['fr','en'].includes(lang) && url.searchParams.size===1) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'"});
        return res.end(`<!doctype html><html lang="${lang}"><head><script src="/smoke-driver.js?lang=${lang}" defer></script></head><body></body></html>`);
      }
      if (req.method==='GET' && url.pathname==='/smoke-driver.js' &&
          ['fr','en'].includes(lang) && url.searchParams.size===1) {
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store',
          'X-Content-Type-Options':'nosniff'});
        return res.end(driver(lang,email,codes[lang]));
      }
      return handler(req,res);
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const origin = `https://127.0.0.1:${server.address().port}`;
    attachBrowserStaffLogin(server,{origin,staffAuthStore:auth,attemptLimit:limiter});
    attachBrowserRecentWorkspaces(server,{origin,recentStore:recent});
    attachReadOnlyDashboardCookie(server);
    const bin = chromeBinary();
    for (const [lang,time] of [['fr',149000],['en',209000]]) {
      clock = time;
      await runChrome(bin,origin+'/smoke-start?lang='+lang,join(directory,'chrome-'+lang),lang,archived.id);
      await assert.rejects(auth.authenticateWithTotp({email,password:PASSWORD,code:codes[lang]}),
        error=>error instanceof StaffAuthError && error.code==='INVALID_CREDENTIALS');
    }
    const [invoices,sessions] = await Promise.all([
      pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1',[businessId]),
      pool.query('SELECT count(*)::integer AS n FROM facturations_staff_sessions WHERE business_id=$1',[businessId]),
    ]);
    assert.equal(invoices.rows[0].n,0,'No invoice drafts created');
    assert.equal(sessions.rows[0].n,3,'Fixture session plus two real browser logins');
    console.log('PASS: Chromium FR/EN → real MFA login → Secure HttpOnly cookie → dashboard → real PostgreSQL archived search.');
    console.log('Scope: isolated PostgreSQL16, local self-signed HTTPS and synthetic customers; no staging or Wave.');
  } finally {
    if (server?.listening) await new Promise(resolve=>server.close(resolve));
    await pool.end();
    rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
