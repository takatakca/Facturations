'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { IssuanceAuthorizationError } = require('./issuance-authorization-store');
const { DraftApprovalError } = require('./draft-approval-store');
const { StoreError } = require('./draft-store');
const { escapeHtml, money } = require('./dashboard-view');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CSRF = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/internal\/review\/([^/]+)\/authorize-issuance$/;
const FIELDS = ['csrf', 'confirmation', 'expectedTotalCents', 'expectedCustomerEmail', 'provider',
  'recipientConfirmed', 'amountConfirmed', 'taxesConfirmed', 'providerPendingConfirmed'];
const MAX_BODY = 3072;
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Autorisation avant émission',
    back: 'Retour à la révision',
    language: 'English',
    other: 'en',
    recipient: 'Destinataire',
    total: 'Total confirmé',
    provider: 'Fournisseur prévu',
    state: 'État',
    stateValue: 'Autorisé — fournisseur externe en attente',
    authorize: 'Enregistrer l’autorisation de passer à l’émission',
    notice: 'Cette étape enregistre seulement votre autorisation de poursuivre vers une émission future. Elle ne crée aucun numéro de facture, n’appelle pas Wave, ne génère pas de PDF officiel, n’envoie aucun courriel et ne prend aucun paiement.',
    recorded: 'Autorisation enregistrée. La facture reste un brouillon non émis et aucun appel Wave n’a été effectué.',
    checks: [
      'J’ai revérifié le destinataire exact de cette facture.',
      'J’ai revérifié les articles et le total calculé.',
      'J’ai revérifié les taxes indiquées et leur applicabilité.',
      'Je comprends que Wave est encore en attente et que cette action n’émet ni n’envoie rien.',
    ],
  }),
  en: Object.freeze({
    title: 'Pre-issuance authorization',
    back: 'Back to owner review',
    language: 'Français',
    other: 'fr',
    recipient: 'Recipient',
    total: 'Confirmed total',
    provider: 'Planned provider',
    state: 'State',
    stateValue: 'Authorized — external provider pending',
    authorize: 'Record authorization to proceed toward issuance',
    notice: 'This step only records your authorization to proceed toward a future issuance. It creates no invoice number, does not call Wave, does not generate an official PDF, sends no email and takes no payment.',
    recorded: 'Authorization recorded. The invoice remains an unissued draft and no Wave call was made.',
    checks: [
      'I rechecked the exact invoice recipient.',
      'I rechecked the line items and calculated total.',
      'I rechecked the supplied taxes and their applicability.',
      'I understand Wave is still pending and this action issues or sends nothing.',
    ],
  }),
});

function send(response, status, type, body, extra = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, ...extra, 'Content-Type': type });
  response.end(body);
}
function deny(response, status) {
  send(response, status, 'text/plain; charset=utf-8', 'Issuance authorization unavailable');
}
function csrfFor(key, token, id) {
  return crypto.createHmac('sha256', key)
    .update('facturations-issuance-authorization-v1:')
    .update(token).update(':').update(id.toLowerCase()).digest('base64url');
}
function snapshotOf(row) {
  const p = row?.preview;
  if (!row || !UUID.test(row.id || '') || row.status !== 'DRAFT' ||
      !p || p.status !== 'DRAFT' || p.persisted !== true || p.currency !== 'CAD' ||
      !Number.isSafeInteger(p.totalCents) || p.totalCents < 0 ||
      typeof p.customer?.name !== 'string' || typeof p.customer?.email !== 'string') {
    throw new TypeError('Immutable calculated draft required');
  }
  return p;
}
function renderPage(row, lang, csrf, authorization = null) {
  if (!Object.hasOwn(COPY, lang)) throw new TypeError('Unsupported language');
  const p = snapshotOf(row);
  const t = COPY[lang];
  const id = row.id.toLowerCase();
  const status = authorization
    ? `<section class="panel" role="status"><strong>${t.recorded}</strong>
         <p><strong>${t.state}:</strong> ${t.stateValue}</p>
         <p><strong>${t.provider}:</strong> WAVE</p></section>`
    : `<section class="panel"><form method="post" action="/internal/review/${id}/authorize-issuance?lang=${lang}" autocomplete="off">
         <input type="hidden" name="csrf" value="${csrf}">
         <input type="hidden" name="confirmation" value="AUTHORIZE_ISSUANCE_PENDING_PROVIDER">
         <input type="hidden" name="expectedTotalCents" value="${p.totalCents}">
         <input type="hidden" name="expectedCustomerEmail" value="${escapeHtml(p.customer.email)}">
         <input type="hidden" name="provider" value="WAVE">
         <div class="checks">
           ${['recipientConfirmed','amountConfirmed','taxesConfirmed','providerPendingConfirmed']
             .map((name, index) => `<label><input type="checkbox" name="${name}" value="yes" required>${t.checks[index]}</label>`).join('')}
         </div><button type="submit">${t.authorize}</button></form></section>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:780px;margin:auto;padding:clamp(18px,4vw,46px)}header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.brand{font-weight:800;letter-spacing:.08em;color:#14536b}a{color:#174b95;font-weight:700}.panel{background:#fff;border:1px solid #dce5ef;border-radius:16px;padding:clamp(18px,4vw,30px);margin:22px 0}.notice{border-left:4px solid #8a5b00;background:#fff5d8;padding:14px;border-radius:8px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:18px}.checks label{display:flex;gap:12px;align-items:flex-start;margin:16px 0}.checks input{width:21px;height:21px;flex-shrink:0}button{font:inherit;font-weight:750;border:0;border-radius:9px;background:#164b9b;color:#fff;padding:13px 18px;cursor:pointer}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #3567b7;outline-offset:3px}@media(max-width:620px){.summary{grid-template-columns:1fr}}
</style></head><body><main><header><div class="brand">GROUPE TAKATAK</div><nav><a href="/internal/review/${id}?lang=${lang}">${t.back}</a> · <a href="/internal/review/${id}/authorize-issuance?lang=${t.other}" lang="${t.other}">${t.language}</a></nav></header>
<h1>${t.title}</h1><p class="notice" role="note">${t.notice}</p>
<section class="panel summary"><div><strong>${t.recipient}</strong><p>${escapeHtml(p.customer.name)}<br>${escapeHtml(p.customer.email)}</p></div><div><strong>${t.total}</strong><p>${escapeHtml(money(p.totalCents, lang))} CAD</p></div></section>
${status}</main></body></html>`;
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = status => { if (done) return; done = true; request.resume(); reject(status); };
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) return fail(413);
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) return fail(413);
      chunks.push(chunk);
    });
    request.on('aborted', () => fail(400));
    request.on('error', () => fail(400));
    request.on('end', () => {
      if (done) return;
      done = true;
      try {
        const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if ([...form.keys()].length !== FIELDS.length ||
            FIELDS.some(field => form.getAll(field).length !== 1) ||
            [...form.keys()].some(field => !FIELDS.includes(field))) return reject(422);
        resolve(form);
      } catch { reject(400); }
    });
  });
}

function attachBrowserIssuanceAuthorization(server, { origin, encryptionKeyHex, businessId,
  staffAuthStore, draftStore, approvalStore, authorizationStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex || '') || !businessId ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !draftStore || typeof draftStore.getDraft !== 'function' ||
      !approvalStore || typeof approvalStore.isApproved !== 'function' ||
      !authorizationStore || typeof authorizationStore.authorize !== 'function' ||
      typeof authorizationStore.getAuthorization !== 'function') {
    throw new TypeError('Dedicated owner issuance authorization dependencies required');
  }
  const key = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-issuance-authorization-csrf-key-v1').digest();
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const match = PATH.exec(url.pathname);
    if (!match) return previous(request, response);
    if (!['GET', 'POST'].includes(request.method)) return deny(response, 405);
    if (!UUID.test(match[1]) || url.hash ||
        [...url.searchParams.keys()].some(keyName => keyName !== 'lang' || url.searchParams.getAll(keyName).length !== 1)) {
      return deny(response, 422);
    }
    const lang = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, lang)) return deny(response, 422);
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return deny(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return deny(response, 401);
    if (request.method === 'POST') {
      if (!sameOrigin(request, origin)) return deny(response, 403);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
        return deny(response, 415);
      }
    }
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return deny(response, 401);
      if (staff.role !== 'OWNER') return deny(response, 403);
      const row = await draftStore.getDraft(match[1]);
      const approved = await approvalStore.isApproved({ draftId: row.id, ownerId: staff.id, sessionToken: token });
      if (!approved) return deny(response, 409);
      if (request.method === 'GET') {
        const authorization = await authorizationStore.getAuthorization({
          draftId: row.id, ownerId: staff.id, sessionToken: token,
        });
        return send(response, 200, 'text/html; charset=utf-8',
          renderPage(row, lang, authorization ? '' : csrfFor(key, token, row.id), authorization));
      }
      const form = await readBody(request);
      const supplied = form.get('csrf');
      const expected = csrfFor(key, token, row.id);
      if (!CSRF.test(supplied || '') || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return deny(response, 403);
      }
      if (form.get('confirmation') !== 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER' ||
          form.get('provider') !== 'WAVE' ||
          FIELDS.slice(5).some(field => form.get(field) !== 'yes')) return deny(response, 422);
      const rawTotal = form.get('expectedTotalCents');
      if (!/^(0|[1-9][0-9]{0,12})$/.test(rawTotal || '')) return deny(response, 422);
      const authorization = await authorizationStore.authorize({
        confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
        draftId: row.id,
        ownerId: staff.id,
        sessionToken: token,
        expectedTotalCents: Number(rawTotal),
        expectedCustomerEmail: form.get('expectedCustomerEmail'),
        provider: 'WAVE',
      });
      return send(response, 200, 'text/html; charset=utf-8',
        renderPage(row, lang, '', authorization));
    } catch (error) {
      if (error instanceof IssuanceAuthorizationError ||
          error instanceof DraftApprovalError || error instanceof StoreError) {
        if ([401, 403, 404, 409, 422].includes(error.statusCode)) return deny(response, error.statusCode);
      }
      if ([400, 413, 422].includes(error)) return deny(response, error);
      return deny(response, 503);
    }
  });
  return server;
}

module.exports = { attachBrowserIssuanceAuthorization, renderIssuanceAuthorization: renderPage, csrfFor };
