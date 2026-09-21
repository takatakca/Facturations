'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readStaffSessionCookie } = require('./staff-session-cookie');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CLIENT = readFileSync(join(__dirname, 'workspace-editor-client.js'), 'utf8');
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Espace de préparation', subtitle: 'Brouillon privé · aucune facture émise',
    intro: 'Saisissez les renseignements, puis enregistrez. Les montants seront calculés par le serveur dans l’aperçu du brouillon enregistré.',
    customer: 'Nom du client', email: 'Courriel du client', address: 'Adresse du client',
    invoiceDate: 'Date de facture', dueDate: 'Échéance', notes: 'Notes de travail',
    line: 'Article', description: 'Description', quantity: 'Quantité', unit: 'Prix unitaire (CAD)',
    discount: 'Rabais total de cet article (CAD)', taxable: 'Article taxable selon les taxes saisies',
    tax: 'Taxe', code: 'Code', label: 'Libellé', rate: 'Taux (%)',
    linesTitle: 'Articles (5 maximum sur cet écran)', taxesTitle: 'Taxes (3 maximum)',
    taxesNotice: 'Aucun taux de taxe n’est prérempli. Vérifiez vous-même les taux et leur applicabilité avant toute utilisation réelle.',
    save: 'Enregistrer le brouillon', reload: 'Recharger la version enregistrée',
    preview: 'Voir l’aperçu de la version enregistrée (si complète)',
    dashboard: 'Tableau de bord', recent: 'Mes brouillons enregistrés', language: 'English', other: 'en',
    notice: 'Brouillon de travail uniquement. Aucun envoi, aucune émission, aucun paiement. L’aperçu n’est disponible qu’après enregistrement et seulement si les renseignements sont complets.',
  }),
  en: Object.freeze({
    title: 'Preparation workspace', subtitle: 'Private work in progress · no invoice issued',
    intro: 'Enter details and save. The server calculates amounts in the saved draft preview.',
    customer: 'Customer name', email: 'Customer email', address: 'Customer address',
    invoiceDate: 'Invoice date', dueDate: 'Due date', notes: 'Working notes',
    line: 'Line item', description: 'Description', quantity: 'Quantity', unit: 'Unit price (CAD)',
    discount: 'Total discount for this line (CAD)', taxable: 'Taxable under the entered taxes',
    tax: 'Tax', code: 'Code', label: 'Label', rate: 'Rate (%)',
    linesTitle: 'Line items (up to 5 on this screen)', taxesTitle: 'Taxes (up to 3)',
    taxesNotice: 'No tax rates are prefilled. Verify rates and applicability before any real use.',
    save: 'Save workspace', reload: 'Reload saved version',
    preview: 'View saved-revision preview (if complete)',
    dashboard: 'Dashboard', recent: 'My saved drafts', language: 'Français', other: 'fr',
    notice: 'Working draft only. No sending, issuance or payment. Preview is available only after saving complete details.',
  }),
});

function renderEditor(language, workspaceId = null) {
  if (!Object.hasOwn(COPY, language) || (workspaceId !== null && !UUID.test(workspaceId))) {
    throw new TypeError('Invalid editor parameters');
  }
  const t = COPY[language];
  const suffix = workspaceId ? `&id=${workspaceId}` : '';
  const lines = Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return `<fieldset class="item"><legend>${t.line} ${n}</legend><div class="two">
<label for="line-${n}-description">${t.description}<input id="line-${n}-description" type="text" maxlength="250" autocomplete="off"></label>
<label for="line-${n}-quantity">${t.quantity}<input id="line-${n}-quantity" type="number" min="1" max="1000" step="1" inputmode="numeric"></label>
<label for="line-${n}-price">${t.unit}<input id="line-${n}-price" type="text" inputmode="decimal" maxlength="12" placeholder="0.00"></label>
<label for="line-${n}-discount">${t.discount}<input id="line-${n}-discount" type="text" inputmode="decimal" maxlength="12" placeholder="0.00"></label>
</div><label class="check"><input id="line-${n}-taxable" type="checkbox">${t.taxable}</label></fieldset>`;
  }).join('');
  const taxes = Array.from({ length: 3 }, (_, index) => {
    const n = index + 1;
    return `<fieldset class="item"><legend>${t.tax} ${n}</legend><div class="three">
<label for="tax-${n}-code">${t.code}<input id="tax-${n}-code" type="text" maxlength="20" autocomplete="off" placeholder="CODE"></label>
<label for="tax-${n}-label">${t.label}<input id="tax-${n}-label" type="text" maxlength="80" autocomplete="off"></label>
<label for="tax-${n}-rate">${t.rate}<input id="tax-${n}-rate" type="text" inputmode="decimal" maxlength="7" placeholder="0.000"></label>
</div></fieldset>`;
  }).join('');
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.55}main{max-width:900px;margin:0 auto;padding:clamp(18px,4vw,48px)}header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px}.brand{font-weight:800;letter-spacing:.1em;color:#14536b;font-size:.85rem}.links{display:flex;gap:16px;flex-wrap:wrap}a{color:#194a91;font-weight:650;text-underline-offset:3px}h1{font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.12;margin:10px 0}.muted{color:#566781}.tag{display:inline-block;background:#e8f0ff;color:#224a91;padding:5px 12px;border-radius:999px;font-weight:700;font-size:.82rem}.panel{background:#fff;border:1px solid #dce5ef;border-radius:18px;padding:clamp(18px,4vw,34px);box-shadow:0 4px 18px #0c1c300a;margin-top:25px}label{display:block;margin:18px 0 7px;font-weight:700}input,textarea{display:block;width:100%;font:inherit;color:inherit;background:#fff;padding:12px 14px;border:1px solid #afc0d4;border-radius:10px;margin-top:6px}textarea{resize:vertical;min-height:95px}input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #4d7dc8;outline-offset:3px}h2{font-size:1.2rem;margin-top:34px}.two,.three{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px}.three{grid-template-columns:repeat(3,minmax(0,1fr))}.item{border:1px solid #dce5ef;border-radius:12px;margin:16px 0;padding:10px 16px 16px;min-width:0}legend{font-weight:750;padding:0 6px}.check{display:flex;align-items:center;gap:10px}.check input{width:20px;height:20px;margin:0;flex-shrink:0}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}button{font:inherit;font-weight:700;border:1px solid #b7c8df;border-radius:10px;padding:12px 18px;background:white;color:#173e76;cursor:pointer}button.primary{background:#164b9b;color:#fff;border-color:#164b9b}button:disabled{opacity:.55;cursor:not-allowed}#preview{display:inline-flex;align-items:center;border:1px solid #b7c8df;border-radius:10px;padding:12px 18px}#preview[hidden]{display:none}#status{padding:12px 14px;background:#eaf1ff;border-radius:10px;color:#234576;margin-top:18px;overflow-wrap:anywhere}#status[data-error="true"]{background:#fff0ed;color:#903728}.foot{margin:22px 0;color:#566781;font-size:.88rem}@media(max-width:620px){.two,.three{grid-template-columns:1fr}}
</style><script src="/internal/editor-client.js" defer></script></head><body><main>
<header><div class="brand">GROUPE TAKATAK</div><nav class="links" aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.dashboard}</a><a href="/internal/recent-workspaces?lang=${language}">${t.recent}</a><a lang="${t.other}" href="/internal/editor?lang=${t.other}${suffix}">${t.language}</a></nav></header>
<span class="tag">${t.subtitle}</span><h1>${t.title}</h1><p class="muted">${t.intro}</p>
<section class="panel"><form id="editor" method="post" action="/internal/editor" autocomplete="off">
<label for="customer">${t.customer}</label><input id="customer" type="text" maxlength="160" autocomplete="off">
<label for="email">${t.email}</label><input id="email" type="email" maxlength="254" autocomplete="off">
<label for="address">${t.address}</label><textarea id="address" maxlength="500"></textarea>
<div class="two"><label for="invoiceDate">${t.invoiceDate}<input id="invoiceDate" type="date"></label><label for="dueDate">${t.dueDate}<input id="dueDate" type="date"></label></div>
<label for="notes">${t.notes}</label><textarea id="notes" maxlength="1000"></textarea>
<h2>${t.linesTitle}</h2>${lines}
<h2>${t.taxesTitle}</h2><p class="muted">${t.taxesNotice}</p>${taxes}
<div class="actions"><button id="save" class="primary" type="submit" disabled>${t.save}</button><button id="reload" type="button" disabled>${t.reload}</button><a id="preview" hidden>${t.preview}</a></div>
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
