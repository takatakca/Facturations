'use strict';

const { TextDecoder } = require('node:util');
const { createStaffSessionCookie, clearStaffSessionCookie, readStaffSessionCookie } = require('./staff-session-cookie');
const { StaffAuthError } = require('./staff-auth-store');

const MAX_FORM_BYTES = 4096;
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const STRINGS = Object.freeze({
  fr: Object.freeze({ pageTitle: 'Connexion sécurisée', title: 'Bienvenue chez GROUPE TAKATAK',
    subtitle: 'Accédez à votre espace Facturations.', email: 'Adresse courriel',
    password: 'Mot de passe', code: 'Code de votre application d’authentification',
    submit: 'Se connecter', language: 'English', other: 'en',
    error: 'Connexion impossible. Vérifiez vos renseignements et réessayez.',
    limited: 'Trop de tentatives. Réessayez plus tard.',
    note: 'Accès réservé aux membres invités et vérifiés. Aucune facture ne sera envoyée depuis cette page.' }),
  en: Object.freeze({ pageTitle: 'Secure sign in', title: 'Welcome to GROUPE TAKATAK',
    subtitle: 'Access your Facturations workspace.', email: 'Email address',
    password: 'Password', code: 'Authenticator app code', submit: 'Sign in',
    language: 'Français', other: 'fr',
    error: 'Sign-in failed. Check your details and try again.',
    limited: 'Too many attempts. Try again later.',
    note: 'Access is limited to invited, verified staff. No invoice is sent from this page.' }),
});

function html(language, message = '') {
  const t = STRINGS[language];
  const notice = message ? `<p class="notice" role="alert">${t[message]}</p>` : '';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.pageTitle} — GROUPE TAKATAK</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f5fa;color:#14203a}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,450px);background:white;border:1px solid #dce2ec;border-radius:20px;padding:clamp(24px,5vw,42px);box-shadow:0 16px 48px #14203a12}.brand{font-size:13px;font-weight:800;letter-spacing:.14em;color:#18428e}.lang{float:right;font-size:13px;color:#164db4;text-decoration:none;font-weight:700}h1{font-size:clamp(24px,5vw,30px);letter-spacing:-.04em;line-height:1.15;margin:24px 0 8px}p{line-height:1.5;color:#50617a;margin:0 0 22px}label{display:block;font-size:14px;font-weight:700;margin:16px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #bfc9d8;border-radius:10px;font:inherit;background:white;color:#14203a}input:focus{outline:3px solid #9dbaf9;outline-offset:1px}button{width:100%;padding:15px;background:#1546a2;border:0;color:white;font:inherit;font-weight:800;border-radius:10px;margin:24px 0 12px;cursor:pointer}button:hover{background:#103a88}.notice{background:#fff1f1;color:#902a2a;padding:12px;border-radius:9px;font-size:14px}.foot{font-size:12px;margin:8px 0 0;color:#5b6880}
</style></head><body><main><div class="brand">GROUPE TAKATAK <a class="lang" href="/internal/login?lang=${t.other}" lang="${t.other}">${t.language}</a></div><h1>${t.title}</h1><p>${t.subtitle}</p>${notice}<form method="post" action="/internal/login?lang=${language}" accept-charset="utf-8"><label for="email">${t.email}</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password">${t.password}</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><label for="code">${t.code}</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button type="submit">${t.submit}</button></form><p class="foot">${t.note}</p></main></body></html>`;
}

function reply(response, status, extra = {}, body = '') {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, ...extra });
  response.end(body);
}

function replyHtml(response, status, language, message = '') {
  reply(response, status, { 'Content-Type': 'text/html; charset=utf-8' }, html(language, message));
}

function replyError(response, status) {
  reply(response, status, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Request unavailable');
}

function sameOrigin(request, origin) {
  // Do not trust X-Forwarded-Host/Proto from clients. Deployment must ensure
  // the app is reachable only through its trusted TLS reverse proxy.
  const expectedHost = new URL(origin).host;
  return request.headers.origin === origin && request.headers.host === expectedHost &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin') &&
    request.headers.authorization === undefined && request.headers['x-admin-key'] === undefined;
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let complete = false;
    const chunks = [];
    let length = 0;
    function fail(status) {
      if (complete) return;
      complete = true;
      request.resume();
      reject(status);
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_FORM_BYTES)) {
      return fail(413);
    }
    request.on('data', chunk => {
      if (complete) return;
      length += chunk.length;
      if (length > MAX_FORM_BYTES) return fail(413);
      chunks.push(chunk);
    });
    request.on('error', () => fail(400));
    request.on('end', () => {
      if (complete) return;
      complete = true;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const params = new URLSearchParams(decoded);
        if (params.size !== 3 || [...params.keys()].some(key =>
          !['email', 'password', 'code'].includes(key) || params.getAll(key).length !== 1)) return reject(422);
        const email = params.get('email');
        const password = params.get('password');
        const code = params.get('code');
        if (email.length > 254 || password.length > 1024 || code.length !== 6) return reject(422);
        resolve({ email, password, code });
      } catch { reject(400); }
    });
  });
}

// Wrap exactly one application handler rather than adding a competing EventEmitter
// listener (which could otherwise execute the original handler after login).
function attachBrowserStaffLogin(server, { origin, staffAuthStore, attemptLimit }) {
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      typeof origin !== 'string' || !/^https:\/\//.test(origin) ||
      new URL(origin).origin !== origin ||
      !staffAuthStore || typeof staffAuthStore.authenticateWithTotp !== 'function' ||
      typeof staffAuthStore.revokeSession !== 'function' ||
      !attemptLimit || typeof attemptLimit.reserve !== 'function' || typeof attemptLimit.reset !== 'function') {
    throw new TypeError('HTTPS browser login requires configured private authentication and limiter');
  }
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return handler(request, response); }
    const isLogin = url.pathname === '/internal/login';
    const isLogout = url.pathname === '/internal/logout';
    if (!isLogin && !isLogout) return handler(request, response);
    if ([...url.searchParams.keys()].some(key => key !== 'lang') || url.searchParams.getAll('lang').length > 1) {
      return replyError(response, 422);
    }
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!['fr', 'en'].includes(language)) return replyError(response, 422);
    if (isLogin && request.method === 'GET') return replyHtml(response, 200, language);
    if (request.method !== 'POST') return replyError(response, 405);
    if (!sameOrigin(request, origin)) return replyError(response, 403);
    if (isLogout) {
      const token = readStaffSessionCookie(request.headers.cookie);
      try {
        if (token) await staffAuthStore.revokeSession(token);
      } catch { return replyError(response, 503); }
      return reply(response, 303, { Location: `/internal/login?lang=${language}`,
        'Set-Cookie': clearStaffSessionCookie() });
    }
    if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      return replyError(response, 415);
    }
    let form;
    try { form = await readForm(request); }
    catch (status) { return replyError(response, status === 413 ? 413 : status === 422 ? 422 : 400); }
    let admitted;
    try { admitted = await attemptLimit.reserve(form.email); }
    catch (error) {
      if (error instanceof StaffAuthError) return replyHtml(response, 401, language, 'error');
      return replyError(response, 503);
    }
    if (!admitted) return replyHtml(response, 429, language, 'limited');
    let session;
    try { session = await staffAuthStore.authenticateWithTotp(form); }
    catch (error) {
      if (error instanceof StaffAuthError && error.code === 'INVALID_CREDENTIALS') {
        return replyHtml(response, 401, language, 'error');
      }
      return replyError(response, 503);
    }
    try { await attemptLimit.reset(form.email); }
    catch {
      try { await staffAuthStore.revokeSession(session.token); } catch { /* Token was never sent to caller. */ }
      return replyError(response, 503);
    }
    return reply(response, 303, { Location: `/internal/dashboard?lang=${language}`,
      'Set-Cookie': createStaffSessionCookie(session.token) });
  });
  return server;
}

module.exports = { attachBrowserStaffLogin, sameOrigin, readForm };
