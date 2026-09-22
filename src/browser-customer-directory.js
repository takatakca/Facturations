'use strict';

const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { customerListOptions } = require('./customer-directory');
const { escapeHtml } = require('./dashboard-view');

const MAX_SEARCH_BYTES = 512;
const LANG = Object.freeze({
  fr: Object.freeze({ title: 'Répertoire clients', dashboard: 'Tableau de bord', language: 'English', other: 'en',
    searchLabel: 'Nom ou courriel du client', search: 'Rechercher', clear: 'Effacer',
    name: 'Client', email: 'Courriel', address: 'Adresse enregistrée', none: 'Aucun client trouvé.',
    previous: 'Page précédente', next: 'Page suivante', page: 'Page',
    note: 'Répertoire privé en lecture seule. Les coordonnées enregistrées peuvent être anciennes : vérifiez le destinataire avant toute émission. Aucun courriel ni facture n’est envoyé.',
    results: 'Seuls les 20 premiers résultats de cette recherche sont affichés.' }),
  en: Object.freeze({ title: 'Customer directory', dashboard: 'Dashboard', language: 'Français', other: 'fr',
    searchLabel: 'Customer name or email', search: 'Search', clear: 'Clear',
    name: 'Customer', email: 'Email', address: 'Saved address', none: 'No customers found.',
    previous: 'Previous page', next: 'Next page', page: 'Page',
    note: 'Private read-only directory. Saved contact details may be outdated: verify the recipient before any issuance. No email or invoice is sent.',
    results: 'Only the first 20 results of this search are shown.' }),
});
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
function reply(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}
function deny(response, status) { reply(response, status, 'text/plain; charset=utf-8', 'Directory unavailable'); }
function pageNumber(value) {
  if (value === null) return 1;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) throw new TypeError('Invalid page');
  return Number(value);
}
function renderCustomerDirectory(data, language = 'fr', query = '') {
  if (!Object.hasOwn(LANG, language) || !data || data.status !== 'CUSTOMERS_ONLY' ||
      !Array.isArray(data.customers) || data.customers.length > 20 ||
      !Number.isSafeInteger(data.page) || data.page < 1 || data.page > 9999 ||
      data.pageSize !== 20 || typeof data.hasMore !== 'boolean' ||
      typeof query !== 'string' || query.length > 80 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new TypeError('Bounded private customer listing required');
  }
  const t = LANG[language];
  const rows = data.customers.map(row => {
    if (!row || typeof row.name !== 'string' || typeof row.email !== 'string' ||
        (row.address !== null && typeof row.address !== 'string')) throw new TypeError('Invalid customer');
    return `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.address || '—')}</td></tr>`;
  }).join('');
  const previous = !query && data.page > 1
    ? `<a href="/internal/customers?lang=${language}&amp;page=${data.page - 1}">${t.previous}</a>` : '';
  const next = !query && data.hasMore && data.page < 9999
    ? `<a href="/internal/customers?lang=${language}&amp;page=${data.page + 1}">${t.next}</a>` : '';
  const results = query ? `<p class="muted">${t.results}</p>` : `<p class="muted">${t.page} · ${t.title}</p>`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f6fa;color:#17253c}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:1020px;margin:auto;padding:clamp(18px,4vw,48px)}header,nav,.controls,.paging{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}header{margin-bottom:30px}.brand{font-weight:800;color:#14536b;letter-spacing:.08em}a{color:#194a91;font-weight:700}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #3567b7;outline-offset:3px}h1{font-size:clamp(1.8rem,5vw,2.7rem)}.panel{background:#fff;border:1px solid #dce5ef;border-radius:16px;padding:clamp(16px,3vw,28px);margin:22px 0}.muted{color:#52647c}.controls{justify-content:flex-start;align-items:end}.controls label{flex:1 1 240px;font-weight:700}.controls input{width:100%;display:block;padding:12px;font:inherit;margin-top:6px;border:1px solid #b3c2d6;border-radius:8px}.controls button{font:inherit;padding:12px 16px;border:0;border-radius:8px;background:#164b9b;color:#fff;font-weight:700;cursor:pointer}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;min-width:520px}th,td{padding:14px 10px;border-bottom:1px solid #e7edf4;overflow-wrap:anywhere;vertical-align:top}.paging{justify-content:flex-start;margin:20px 0}.notice{background:#eaf1ff;padding:14px;border-left:4px solid #3567b7;border-radius:8px}</style></head><body><main>
<header><div class="brand">GROUPE TAKATAK</div><nav aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.dashboard}</a><a href="/internal/customers?lang=${t.other}" lang="${t.other}">${t.language}</a></nav></header>
<h1>${t.title}</h1><p class="notice" role="note">${t.note}</p><section class="panel"><form class="controls" method="post" action="/internal/customers?lang=${language}" autocomplete="off"><label for="q">${t.searchLabel}<input id="q" name="q" type="search" minlength="2" maxlength="80" value="${escapeHtml(query)}" autocomplete="off"></label><button type="submit">${t.search}</button><a href="/internal/customers?lang=${language}">${t.clear}</a></form></section>
<section class="panel" aria-label="${t.title}">${rows ? `<div class="scroll" role="region" aria-label="${t.title}" tabindex="0"><table><thead><tr><th scope="col">${t.name}</th><th scope="col">${t.email}</th><th scope="col">${t.address}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${t.none}</p>`}</section>${results}<nav class="paging" aria-label="${t.page}">${previous}${next}</nav></main></body></html>`;
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function readSearch(request) {
  return new Promise((resolve, reject) => {
    let finished = false, size = 0;
    const chunks = [];
    const fail = status => { if (finished) return; finished = true; request.resume(); reject(status); };
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_SEARCH_BYTES)) return fail(413);
    request.on('data', chunk => { if (finished) return; size += chunk.length;
      if (size > MAX_SEARCH_BYTES) return fail(413); chunks.push(chunk); });
    request.on('aborted', () => fail(400));
    request.on('error', () => fail(400));
    request.on('end', () => { if (finished) return; finished = true;
      try {
        const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if ([...form.keys()].length !== 1 || form.getAll('q').length !== 1) return reject(422);
        const search = form.get('q');
        if (search.length > 80 || /[\u0000-\u001f\u007f]/u.test(search)) return reject(422);
        resolve(search.trim());
      } catch { reject(422); }
    });
  });
}
// Attach to the isolated private browser service only. Never grant browser cookies to /api/*.
function attachBrowserCustomerDirectory(server, { origin, businessId, staffAuthStore, customerDirectory }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Reject invalid configuration. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !businessId || !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !customerDirectory || typeof customerDirectory.listCustomers !== 'function') {
    throw new TypeError('Dedicated owner customer directory dependencies required');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    if (url.pathname !== '/internal/customers') return previous(request, response);
    if (!['GET', 'POST'].includes(request.method)) return deny(response, 405);
    if (url.hash || [...url.searchParams.keys()].some(key =>
      !['lang', 'page'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
      (request.method === 'POST' && url.searchParams.has('page'))) return deny(response, 422);
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(LANG, language)) return deny(response, 422);
    let page;
    try { page = pageNumber(url.searchParams.get('page')); } catch { return deny(response, 422); }
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return deny(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return deny(response, 401);
    if (request.method === 'POST' && !sameOrigin(request, origin)) return deny(response, 403);
    if (request.method === 'POST' &&
        !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return deny(response, 415);
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return deny(response, 401);
      if (staff.role !== 'OWNER') return deny(response, 403);
      const query = request.method === 'POST' ? await readSearch(request) : '';
      if (query && query.length < 2) return deny(response, 422);
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (query) params.set('q', query);
      const data = await customerDirectory.listCustomers(customerListOptions(params));
      reply(response, 200, 'text/html; charset=utf-8', renderCustomerDirectory(data, language, query));
    } catch (error) {
      if ([400, 413, 422].includes(error)) return deny(response, error);
      return deny(response, 503);
    }
  });
  return server;
}
module.exports = { attachBrowserCustomerDirectory, renderCustomerDirectory };
