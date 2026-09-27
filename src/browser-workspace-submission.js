'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { previewDraft, DraftValidationError } = require('./draft-preview');
const { WorkspaceError } = require('./draft-workspace-store');
const { SubmissionError } = require('./workspace-submission-store');
const { escapeHtml, money } = require('./dashboard-view');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CSRF = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/internal\/submit\/([^/]+)$/;
const FIELDS = ['csrf', 'confirmation', 'expectedRevision', 'expectedTotalCents', 'expectedCustomerEmail', 'reviewed'];
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});
const COPY = Object.freeze({
  fr: Object.freeze({ title: 'Figer ce brouillon pour révision',
    notice: 'Vous créez une copie immuable à soumettre à la révision interne. Aucune facture n’est émise ou envoyée. Après cette action, cet espace de travail ne pourra plus être modifié.',
    customer: 'Destinataire', dates: 'Dates', lines: 'Articles', taxes: 'Taxes indiquées',
    subtotal: 'Sous-total', taxTotal: 'Total des taxes', total: 'Total calculé',
    discount: 'Rabais', notes: 'Notes', noTaxes: 'Aucune taxe indiquée.',
    reviewed: 'J’ai vérifié le client, les montants, les dates et les taxes applicables de cette version enregistrée.',
    submit: 'Figer et envoyer à la révision interne', incomplete: 'Complétez les renseignements dans l’éditeur et enregistrez-les avant de soumettre ce brouillon.',
    edit: 'Retour à l’éditeur', back: 'Tableau de bord', other: 'en', language: 'English' }),
  en: Object.freeze({ title: 'Freeze draft for review',
    notice: 'You are creating an immutable copy for internal review. No invoice is issued or sent. This working draft cannot be edited after submission.',
    customer: 'Recipient', dates: 'Dates', lines: 'Line items', taxes: 'Specified taxes',
    subtotal: 'Subtotal', taxTotal: 'Total tax', total: 'Calculated total',
    discount: 'Discount', notes: 'Notes', noTaxes: 'No tax specified.',
    reviewed: 'I checked the recipient, amounts, dates and applicable taxes of this saved revision.',
    submit: 'Freeze and submit for internal review', incomplete: 'Complete and save the details in the editor before submitting this draft.',
    edit: 'Back to editor', back: 'Dashboard', other: 'fr', language: 'Français' }),
});
function send(response, status, type, body, extra = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
  response.end(body);
}
function plain(response, status) { send(response, status, 'text/plain; charset=utf-8', 'Submission unavailable'); }
function page(lang, id, body) {
  const t = COPY[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:850px;margin:auto;padding:clamp(16px,4vw,46px)}nav{display:flex;gap:18px;flex-wrap:wrap}a{color:#164b9b;font-weight:700}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #3567b7;outline-offset:3px}.brand{color:#14536b;font-weight:800;letter-spacing:.07em}.panel{background:white;border:1px solid #dce5ef;border-radius:15px;padding:clamp(16px,4vw,27px);margin:20px 0;overflow-wrap:anywhere}.line{padding:9px 0;border-bottom:1px solid #e7edf4;white-space:pre-wrap}.notice{border-left:4px solid #3567b7;background:#eaf1ff;padding:14px;border-radius:6px}label{display:flex;gap:10px;align-items:flex-start;margin:15px 0}input[type=checkbox]{width:21px;height:21px;flex-shrink:0}button{border:0;background:#164b9b;color:#fff;font:inherit;font-weight:750;border-radius:9px;padding:13px 18px;cursor:pointer}
</style></head><body><main><p class="brand">GROUPE TAKATAK</p><nav><a href="/internal/dashboard?lang=${lang}">${t.back}</a><a href="/internal/editor?lang=${lang}&amp;id=${id}">${t.edit}</a><a lang="${t.other}" href="/internal/submit/${id}?lang=${t.other}">${t.language}</a></nav><h1>${t.title}</h1><p class="notice" role="note">${t.notice}</p>${body}</main></body></html>`;
}
function csrfFor(key, token, id, revision) {
  return crypto.createHmac('sha256', key).update('workspace-submit-v1:').update(token)
    .update(':').update(id.toLowerCase()).update(':').update(String(revision)).digest('base64url');
}
function renderSubmission(row, lang, csrf) {
  const t = COPY[lang];
  if (!row || !UUID.test(row.id || '') || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      row.status !== 'WORK_IN_PROGRESS' || row.invoiceIssued !== false || row.emailed !== false) {
    throw new TypeError('Saved working draft required');
  }
  const p = previewDraft(row.content);
  const amount = cents => escapeHtml(money(cents, lang));
  const items = p.lines.map(line => `<p class="line">${escapeHtml(line.description)} · ${line.quantity} × ${amount(line.unitPriceCents)} · ${t.discount}: ${amount(line.discountCents)} · ${amount(line.lineTotalCents)}</p>`).join('');
  const taxes = p.taxes.map(tax => {
    const rate = `${Math.floor(tax.rateMilliPercent / 1000)}.${String(tax.rateMilliPercent % 1000).padStart(3, '0')}%`;
    return `<p class="line">${escapeHtml(tax.label)} (${escapeHtml(tax.code)}, ${rate}) · ${amount(tax.amountCents)}</p>`;
  }).join('');
  const notes = p.notes ? `<h2>${t.notes}</h2><p class="line">${escapeHtml(p.notes)}</p>` : '';
  return page(lang, row.id, `<section class="panel"><h2>${t.customer}</h2><p>${escapeHtml(p.customer.name)} · ${escapeHtml(p.customer.email)}</p><p>${escapeHtml(p.customer.address || '')}</p><h2>${t.dates}</h2><p>${escapeHtml(p.invoiceDate)} · ${escapeHtml(p.dueDate)}</p><h2>${t.lines}</h2>${items}<p>${t.subtotal}: ${amount(p.subtotalCents)}</p><h2>${t.taxes}</h2>${taxes || `<p>${t.noTaxes}</p>`}<p>${t.taxTotal}: ${amount(p.taxTotalCents)}</p><p><strong>${t.total}: ${amount(p.totalCents)}</strong></p>${notes}</section><section class="panel"><form method="post" action="/internal/submit/${row.id}?lang=${lang}" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="confirmation" value="CREATE_IMMUTABLE_DRAFT_ONLY"><input type="hidden" name="expectedRevision" value="${row.revision}"><input type="hidden" name="expectedTotalCents" value="${p.totalCents}"><input type="hidden" name="expectedCustomerEmail" value="${escapeHtml(p.customer.email)}"><label><input type="checkbox" name="reviewed" value="yes" required>${t.reviewed}</label><button type="submit">${t.submit}</button></form></section>`);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = status => { if (done) return; done = true; request.resume(); reject(status); };
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 2048)) return fail(413);
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > 2048) return fail(413);
      chunks.push(chunk);
    });
    request.on('aborted', () => fail(400));
    request.on('error', () => fail(400));
    request.on('end', () => {
      if (done) return;
      done = true;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const form = new URLSearchParams(decoded);
        if ([...form.keys()].length !== FIELDS.length ||
            FIELDS.some(field => form.getAll(field).length !== 1) ||
            [...form.keys()].some(field => !FIELDS.includes(field))) return reject(422);
        resolve(form);
      } catch { reject(400); }
    });
  });
}
function sameOrigin(req, origin) {
  return req.headers.origin === origin && req.headers.host === new URL(origin).host &&
    (req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin');
}
function attachBrowserWorkspaceSubmission(server, { origin, encryptionKeyHex, businessId,
  staffAuthStore, workspaceStore, submissionStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !/^[0-9a-f]{64}$/i.test(encryptionKeyHex || '') || !businessId ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !workspaceStore || typeof workspaceStore.load !== 'function' ||
      !submissionStore || typeof submissionStore.submit !== 'function') {
    throw new TypeError('Dedicated HTTPS owner submission dependencies required');
  }
  const key = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-workspace-submission-csrf-key-v1').digest();
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const item = PATH.exec(url.pathname);
    if (!item) return previous(request, response);
    if (!['GET', 'POST'].includes(request.method)) return plain(response, 405);
    if (!UUID.test(item[1]) || [...url.searchParams.keys()].some(field =>
      field !== 'lang' || url.searchParams.getAll(field).length !== 1)) return plain(response, 422);
    const lang = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, lang) || url.hash) return plain(response, 422);
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return plain(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return plain(response, 401);
    if (request.method === 'POST') {
      if (!sameOrigin(request, origin)) return plain(response, 403);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return plain(response, 415);
    }
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return plain(response, 401);
      if (staff.role !== 'OWNER') return plain(response, 403);
      const row = await workspaceStore.load({ token, workspaceId: item[1] });
      if (request.method === 'GET') {
        try {
          return send(response, 200, 'text/html; charset=utf-8',
            renderSubmission(row, lang, csrfFor(key, token, row.id, row.revision)));
        } catch (error) {
          if (!(error instanceof DraftValidationError)) throw error;
          return send(response, 422, 'text/html; charset=utf-8',
            page(lang, row.id, `<section class="panel" role="status">${COPY[lang].incomplete}</section>`));
        }
      }
      const form = await readBody(request);
      const revisionRaw = form.get('expectedRevision');
      if (!/^[1-9][0-9]{0,9}$/.test(revisionRaw || '') || Number(revisionRaw) > 2147483647) return plain(response, 422);
      const revision = Number(revisionRaw);
      if (row.revision !== revision) return plain(response, 409);
      const supplied = form.get('csrf');
      const expected = csrfFor(key, token, row.id, revision);
      if (typeof supplied !== 'string' || !CSRF.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return plain(response, 403);
      if (form.get('confirmation') !== 'CREATE_IMMUTABLE_DRAFT_ONLY' || form.get('reviewed') !== 'yes') {
        return plain(response, 422);
      }
      const totalRaw = form.get('expectedTotalCents');
      if (!/^(0|[1-9][0-9]{0,12})$/.test(totalRaw || '')) return plain(response, 422);
      const result = await submissionStore.submit({ confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY',
        workspaceId: row.id, sessionToken: token, expectedRevision: revision,
        expectedTotalCents: Number(totalRaw), expectedCustomerEmail: form.get('expectedCustomerEmail') });
      return send(response, 303, 'text/plain; charset=utf-8', 'See immutable draft for review',
        { Location: `/internal/review/${result.draftId}?lang=${lang}` });
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof SubmissionError || error instanceof DraftValidationError) {
        if ([401, 403, 404, 409, 413, 422].includes(error.statusCode)) return plain(response, error.statusCode);
      }
      if ([400, 413, 422].includes(error)) return plain(response, error);
      return plain(response, 503);
    }
  });
  return server;
}

module.exports = { attachBrowserWorkspaceSubmission, renderSubmission, csrfFor };
