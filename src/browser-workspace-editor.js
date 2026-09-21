'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readStaffSessionCookie } = require('./staff-session-cookie');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CLIENT = readFileSync(join(__dirname, 'workspace-editor-client.js'), 'utf8');
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Espace de préparation', subtitle: 'Brouillon privé · aucune facture émise',
    intro: 'Préparez les coordonnées et les notes. Les articles, les taxes et les montants ne sont pas encore modifiables sur cet écran.',
    customer: 'Nom du client', notes: 'Notes de travail', save: 'Enregistrer le brouillon',
    reload: 'Recharger la version enregistrée', dashboard: 'Retour au tableau de bord',
    language: 'English', other: 'en', notice: 'Enregistrement manuel uniquement. Aucun envoi, aucune émission, aucun paiement.',
  }),
  en: Object.freeze({
    title: 'Preparation workspace', subtitle: 'Private work in progress · no invoice issued',
    intro: 'Prepare customer details and notes. Line items, taxes and amounts cannot yet be edited on this screen.',
    customer: 'Customer name', notes: 'Working notes', save: 'Save workspace',
    reload: 'Reload saved version', dashboard: 'Back to dashboard',
    language: 'Français', other: 'fr', notice: 'Manual saving only. No sending, issuance or payment.',
  }),
});

function renderEditor(language, workspaceId = null) {
  if (!Object.hasOwn(COPY, language) || (workspaceId !== null && !UUID.test(workspaceId))) {
    throw new TypeError('Invalid editor parameters');
  }
  const t = COPY[language];
  const suffix = workspaceId ? `&id=${workspaceId}` : '';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.55}main{max-width:850px;margin:0 auto;padding:clamp(18px,4vw,48px)}header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px}.brand{font-weight:800;letter-spacing:.1em;color:#14536b;font-size:.85rem}.links{display:flex;gap:16px;flex-wrap:wrap}a{color:#194a91;font-weight:650;text-underline-offset:3px}h1{font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.12;margin:10px 0}.muted{color:#566781}.tag{display:inline-block;background:#e8f0ff;color:#224a91;padding:5px 12px;border-radius:999px;font-weight:700;font-size:.82rem}.panel{background:#fff;border:1px solid #dce5ef;border-radius:18px;padding:clamp(18px,4vw,34px);box-shadow:0 4px 18px #0c1c300a;margin-top:25px}label{display:block;margin:22px 0 7px;font-weight:700}input,textarea{display:block;width:100%;font:inherit;color:inherit;background:#fff;padding:12px 14px;border:1px solid #afc0d4;border-radius:10px}textarea{resize:vertical;min-height:145px}input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #4d7dc8;outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}button{font:inherit;font-weight:700;border:1px solid #b7c8df;border-radius:10px;padding:12px 18px;background:white;color:#173e76;cursor:pointer}button.primary{background:#164b9b;color:#fff;border-color:#164b9b}button:disabled{opacity:.55;cursor:not-allowed}#status{padding:12px 14px;background:#eaf1ff;border-radius:10px;color:#234576;margin-top:18px;overflow-wrap:anywhere}#status[data-error="true"]{background:#fff0ed;color:#903728}.foot{margin:22px 0;color:#566781;font-size:.88rem}
</style><script src="/internal/editor-client.js" defer></script></head><body><main>
<header><div class="brand">GROUPE TAKATAK</div><nav class="links" aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.dashboard}</a><a lang="${t.other}" href="/internal/editor?lang=${t.other}${suffix}">${t.language}</a></nav></header>
<span class="tag">${t.subtitle}</span><h1>${t.title}</h1><p class="muted">${t.intro}</p>
<section class="panel"><form id="editor" method="post" action="/internal/editor" autocomplete="off">
<label for="customer">${t.customer}</label><input id="customer" name="customer" type="text" maxlength="160" autocomplete="off">
<label for="notes">${t.notes}</label><textarea id="notes" name="notes" maxlength="1000"></textarea>
<div class="actions"><button id="save" class="primary" type="submit" disabled>${t.save}</button><button id="reload" type="button" disabled>${t.reload}</button></div>
<p id="status" role="status" aria-live="polite"></p></form></section><p class="foot">${t.notice}</p>
</main></body></html>`;
}

function send(response, status, contentType, body, extra = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': contentType, ...extra });
  response.end(body);
}

// Attach AFTER workspace JSON routes and BEFORE the read-only dashboard cookie listener.
// It never upgrades the browser cookie into an API bearer credential.
function attachBrowserWorkspaceEditor(server, { origin, staffAuthStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !staffAuthStore || typeof staffAuthStore.getSession !== 'function') {
    throw new TypeError('Private HTTPS editor and staff session store required');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const isPage = url.pathname === '/internal/editor';
    const isScript = url.pathname === '/internal/editor-client.js';
    if (!isPage && !isScript) return previous(request, response);
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) {
      return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    let staff;
    try { staff = await staffAuthStore.getSession(token); }
    catch { return send(response, 503, 'text/plain; charset=utf-8', 'Service unavailable'); }
    if (!staff || !['OWNER', 'STAFF'].includes(staff.role)) {
      return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    }
    if (isScript) {
      if (url.search || url.hash) return send(response, 422, 'text/plain; charset=utf-8', 'Invalid query');
      return send(response, 200, 'text/javascript; charset=utf-8', CLIENT,
        { 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    }
    if ([...url.searchParams.keys()].some(key => !['lang', 'id'].includes(key) || url.searchParams.getAll(key).length !== 1)) {
      return send(response, 422, 'text/plain; charset=utf-8', 'Invalid query');
    }
    const language = url.searchParams.get('lang') ?? 'fr';
    const id = url.searchParams.get('id');
    if (!Object.hasOwn(COPY, language) || (id !== null && !UUID.test(id))) {
      return send(response, 422, 'text/plain; charset=utf-8', 'Invalid query');
    }
    return send(response, 200, 'text/html; charset=utf-8', renderEditor(language, id), {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
  });
  return server;
}

module.exports = { attachBrowserWorkspaceEditor, renderEditor };
