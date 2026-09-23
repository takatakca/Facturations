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
const FIELDS = ['csrf', 'confirmation', 'provider', 'expectedTotalCents',
  'expectedCustomerEmail', 'reviewed'];
const MAX_BODY = 2048;
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
    title: 'Autorisation d’émission',
    back: 'Retour à la révision',
    other: 'en',
    language: 'English',
    recipient: 'Destinataire',
    total: 'Total vérifié',
    provider: 'Fournisseur prévu',
    status: 'Autorisation enregistrée',
    statusText: 'Le propriétaire a autorisé le passage vers l’émission. La facture demeure non émise tant que le connecteur fournisseur n’a pas exécuté et réconcilié l’opération.',
    warning: 'Cette action n’émet pas la facture. Elle ne crée aucun numéro officiel, n’appelle pas Wave, ne génère aucun PDF officiel et n’envoie aucun courriel. Elle enregistre uniquement une autorisation immuable à poursuivre vers le fournisseur après validation de l’intégration.',
    reviewed: 'Je confirme une seconde fois le destinataire et le total, et j’autorise uniquement la prochaine étape vers Wave lorsque le connecteur autorisé sera disponible.',
    submit: 'Autoriser la prochaine étape d’émission',
    pending: 'EN ATTENTE DU FOURNISSEUR — NON ÉMIS',
  }),
  en: Object.freeze({
    title: 'Issuance authorization',
    back: 'Back to review',
    other: 'fr',
    language: 'Français',
    recipient: 'Recipient',
    total: 'Verified total',
    provider: 'Planned provider',
    status: 'Authorization recorded',
    statusText: 'The owner authorized progression toward issuance. The invoice remains unissued until the provider connector executes and reconciles the operation.',
    warning: 'This action does not issue the invoice. It creates no official invoice number, makes no Wave call, generates no official PDF and sends no email. It only records an immutable authorization to proceed toward the provider after the integration is validated.',
    reviewed: 'I confirm the recipient and total again, and authorize only the next step toward Wave when the authorized connector is available.',
    submit: 'Authorize the next issuance step',
    pending: 'PENDING PROVIDER — UNISSUED',
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
function sameOrigin(request, origin) {
  return request.headers.origin === origin &&
    request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined ||
      request.headers['sec-fetch-site'] === 'same-origin');
}
function csrfFor(key, token, id) {
  return crypto.createHmac('sha256', key)
    .update('facturations-issuance-authorization-v1:')
    .update(token).update(':').update(id.toLowerCase())
    .digest('base64url');
}
function snapshotOf(row) {
  const p = row?.preview;
  if (!row || !UUID.test(row.id || '') || row.status !== 'DRAFT' ||
      !p || p.status !== 'DRAFT' || p.persisted !== true ||
      p.currency !== 'CAD' || !Number.isSafeInteger(p.totalCents) ||
      p.totalCents < 0 || typeof p.customer?.email !== 'string') {
    throw new TypeError('Immutable draft preview required');
  }
  return p;
}
function renderPage(row, lang, csrf, authorization = null) {
  if (!Object.hasOwn(COPY, lang)) throw new TypeError('Unsupported language');
  const p = snapshotOf(row);
  const t = COPY[lang];
  const id = row.id.toLowerCase();
  const back = `/internal/review/${id}?lang=${lang}`;
  const switchLink = `/internal/review/${id}/authorize-issuance?lang=${t.other}`;
  const state = authorization
    ? `<section class="panel status" role="status"><strong>${t.pending}</strong><h2>${t.status}</h2><p>${t.statusText}</p><p>${t.provider}: ${escapeHtml(authorization.provider)}</p></section>`
    : `<section class="panel"><form method="post" action="/internal/review/${id}/authorize-issuance?lang=${lang}" autocomplete="off">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="confirmation" value="AUTHORIZE_ISSUANCE_PENDING_PROVIDER">
<input type="hidden" name="provider" value="WAVE">
<input type="hidden" name="expectedTotalCents" value="${p.totalCents}">
<input type="hidden" name="expectedCustomerEmail" value="${escapeHtml(p.customer.email)}">
<label><input type="checkbox" name="reviewed" value="yes" required> ${t.reviewed}</label>
<button type="submit">${t.submit}</button></form></section>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f6fa;color:#17253c}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:820px;margin:auto;padding:clamp(18px,4vw,48px)}header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px}.brand{font-weight:800;letter-spacing:.08em;color:#14536b}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#194a91;font-weight:700}.panel{background:#fff;border:1px solid #dce5ef;border-radius:16px;padding:clamp(18px,4vw,30px);margin:22px 0}.warning{border-left:4px solid #9b6416;background:#fff4dc;padding:15px;border-radius:8px}.summary{display:grid;grid-template-columns:1fr 1fr;gap:18px}.summary div{background:#fff;padding:16px;border:1px solid #dce5ef;border-radius:12px}.status{border:2px solid #9b6416}.status>strong{letter-spacing:.06em}label{display:flex;align-items:flex-start;gap:12px}input[type=checkbox]{width:22px;height:22px;flex-shrink:0}button{font:inherit;font-weight:750;border:0;border-radius:9px;padding:13px 18px;margin-top:20px;background:#164b9b;color:#fff;cursor:pointer}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #3567b7;outline-offset:3px}@media(max-width:620px){.summary{grid-template-columns:1fr}}</style></head><body><main>
<header><div class="brand">GROUPE TAKATAK</div><nav><a href="${back}">${t.back}</a><a href="${switchLink}" lang="${t.other}">${t.language}</a></nav></header>
<h1>${t.title}</h1><p class="warning" role="note">${t.warning}</p>
<section class="summary"><div><strong>${t.recipient}</strong><p>${escapeHtml(p.customer.email)}</p></div><div><strong>${t.total}</strong><p>${escapeHtml(money(p.totalCents, lang))}</p></div></section>
${state}</main></body></html>`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let done = false, size = 0;
    const chunks = [];
    const fail = status => {
      if (done) return;
      done = true;
      request.resume();
      reject(status);
    };
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) ||
        Number(declared) > MAX_BODY)) return fail(413);
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
        const form = new URLSearchParams(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        );
        if ([...form.keys()].length !== FIELDS.length ||
            FIELDS.some(field => form.getAll(field).length !== 1) ||
            [...form.keys()].some(field => !FIELDS.includes(field))) return reject(422);
        resolve(form);
      } catch {
        reject(422);
      }
    });
  });
}

function attachBrowserIssuanceAuthorization(server, {
  origin, businessId, encryptionKeyHex, staffAuthStore, draftStore,
  approvalStore, authorizationStore,
}) {
  let validOrigin = false;
  try {
    validOrigin = typeof origin === 'string' && origin.startsWith('https://') &&
      new URL(origin).origin === origin;
  } catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' ||
      server.listeners('request').length !== 1 || !validOrigin || !businessId ||
      !/^[a-f0-9]{64}$/i.test(encryptionKeyHex || '') ||
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
        [...url.searchParams.keys()].some(keyName =>
          keyName !== 'lang' || url.searchParams.getAll(keyName).length !== 1)) {
      return deny(response, 422);
    }
    const lang = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, lang)) return deny(response, 422);
    if (request.headers.authorization !== undefined ||
        request.headers['x-admin-key'] !== undefined) return deny(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return deny(response, 401);
    if (request.method === 'POST') {
      if (!sameOrigin(request, origin)) return deny(response, 403);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i
        .test(request.headers['content-type'] || '')) return deny(response, 415);
    }
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return deny(response, 401);
      if (staff.role !== 'OWNER') return deny(response, 403);
      const approved = await approvalStore.isApproved({
        draftId: match[1], ownerId: staff.id, sessionToken: token,
      });
      if (!approved) return deny(response, 409);
      const row = await draftStore.getDraft(match[1]);
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
      if (!CSRF.test(supplied || '') ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        return deny(response, 403);
      }
      if (form.get('confirmation') !== 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER' ||
          form.get('provider') !== 'WAVE' || form.get('reviewed') !== 'yes') {
        return deny(response, 422);
      }
      const rawTotal = form.get('expectedTotalCents');
      if (!/^(0|[1-9][0-9]{0,12})$/.test(rawTotal || '')) return deny(response, 422);
      await authorizationStore.authorize({
        confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
        draftId: row.id,
        ownerId: staff.id,
        sessionToken: token,
        expectedTotalCents: Number(rawTotal),
        expectedCustomerEmail: form.get('expectedCustomerEmail'),
        provider: 'WAVE',
      });
      return send(response, 303, 'text/plain; charset=utf-8', '', {
        Location: `/internal/review/${row.id}/authorize-issuance?lang=${lang}`,
      });
    } catch (error) {
      if (error instanceof IssuanceAuthorizationError ||
          error instanceof DraftApprovalError || error instanceof StoreError) {
        if ([401, 403, 404, 409, 422].includes(error.statusCode)) {
          return deny(response, error.statusCode);
        }
      }
      if ([400, 413, 422].includes(error)) return deny(response, error);
      return deny(response, 503);
    }
  });
  return server;
}

module.exports = {
  attachBrowserIssuanceAuthorization,
  renderIssuanceAuthorization: renderPage,
  csrfFor,
};
