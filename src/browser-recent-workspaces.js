'use strict';

const { readStaffSessionCookie } = require('./staff-session-cookie');
const { WorkspaceError } = require('./draft-workspace-store');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COPY = Object.freeze({
  fr: Object.freeze({ title: 'Mes brouillons de travail', new: 'Nouveau brouillon',
    back: 'Tableau de bord', other: 'en', language: 'English',
    empty: 'Aucun brouillon enregistré. Commencez un nouveau brouillon.',
    unnamed: 'Sans nom de client', revision: 'Révision', updated: 'Mis à jour',
    preview: 'Aperçu calculé (si complet)',
    note: 'Vos 20 espaces de travail les plus récents. Ce ne sont pas des factures émises.' }),
  en: Object.freeze({ title: 'My working drafts', new: 'New draft',
    back: 'Dashboard', other: 'fr', language: 'Français',
    empty: 'No saved drafts yet. Start a new draft.',
    unnamed: 'Unnamed customer', revision: 'Revision', updated: 'Updated',
    preview: 'Calculated preview (if complete)',
    note: 'Your 20 most recent workspaces. These are not issued invoices.' }),
});
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'",
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function renderRecentWorkspaces(result, language = 'fr') {
  if (!Object.hasOwn(COPY, language) || !result || result.status !== 'WORKSPACES_ONLY' ||
      !Array.isArray(result.workspaces) || result.workspaces.length > 20) {
    throw new TypeError('Bounded private workspace listing required');
  }
  const t = COPY[language];
  const items = result.workspaces.map(row => {
    if (!row || !UUID.test(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        (row.customerName !== null && typeof row.customerName !== 'string') ||
        typeof row.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(row.updatedAt)) {
      throw new TypeError('Invalid private workspace summary');
    }
    const label = row.customerName?.trim() || t.unnamed;
    const date = escapeHtml(row.updatedAt.slice(0, 16).replace('T', ' ')) + ' UTC';
    return `<li><a href="/internal/editor?lang=${language}&amp;id=${row.id}">${escapeHtml(label)}</a>` +
      `<span class="meta">${t.revision} ${row.revision} · ${t.updated} ${date}</span>` +
      `<a class="preview" href="/internal/workspaces/${row.id}/preview?lang=${language}">${t.preview}</a></li>`;
  }).join('');
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title>
<style>:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#16253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:850px;margin:auto;padding:clamp(18px,4vw,48px)}header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px}.brand{font-size:.85rem;font-weight:800;letter-spacing:.1em;color:#14536b}nav{display:flex;flex-wrap:wrap;gap:16px}a{color:#194a91;font-weight:700;text-underline-offset:3px;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #4d7dc8;outline-offset:3px}h1{font-size:clamp(1.8rem,5vw,2.8rem);margin:30px 0 8px}p{color:#52647c}.panel{background:#fff;border:1px solid #dce5ef;border-radius:18px;padding:clamp(18px,4vw,32px);margin:26px 0}ul{list-style:none;padding:0;margin:0}li{padding:18px 0;border-top:1px solid #e9eef5}li:first-child{border-top:0}.meta{display:block;color:#52647c;font-size:.86rem;margin-top:5px}.preview{display:inline-block;margin-top:9px;font-size:.9rem}.new{display:inline-block;background:#164b9b;color:#fff;border-radius:9px;padding:11px 16px;text-decoration:none}</style></head>
<body><main><header><div class="brand">GROUPE TAKATAK</div><nav aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.back}</a><a href="/internal/recent-workspaces?lang=${t.other}" lang="${t.other}">${t.language}</a></nav></header>
<h1>${t.title}</h1><p>${t.note}</p><a class="new" href="/internal/editor?lang=${language}">${t.new}</a>
<section class="panel" aria-label="${t.title}">${items ? `<ul>${items}</ul>` : `<p>${t.empty}</p>`}</section></main></body></html>`;
}

function send(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}

// Runs after the editor wrapper; never turns a cookie into an API bearer token.
function attachBrowserRecentWorkspaces(server, { origin, recentStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !recentStore || typeof recentStore.list !== 'function') {
    throw new TypeError('Dedicated HTTPS browser and private recent-workspace store required');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    if (url.pathname !== '/internal/recent-workspaces') return previous(request, response);
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if ([...url.searchParams.keys()].some(key => key !== 'lang' || url.searchParams.getAll(key).length !== 1)) {
      return send(response, 422, 'text/plain; charset=utf-8', 'Invalid query');
    }
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, language)) return send(response, 422, 'text/plain; charset=utf-8', 'Invalid language');
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) {
      return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    try {
      const listing = await recentStore.list({ token });
      return send(response, 200, 'text/html; charset=utf-8', renderRecentWorkspaces(listing, language));
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'UNAUTHORIZED') {
        return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
      }
      return send(response, 503, 'text/plain; charset=utf-8', 'Service unavailable');
    }
  });
  return server;
}

module.exports = { attachBrowserRecentWorkspaces, renderRecentWorkspaces };
