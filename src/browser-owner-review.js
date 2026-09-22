'use strict';

// Only existing immutable invoice_drafts can receive an INTERNAL approval here.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { DraftApprovalError } = require('./draft-approval-store');
const { StoreError } = require('./draft-store');
const { escapeHtml, money } = require('./dashboard-view');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CSRF = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/internal\/review\/([^/]+)$/;
const FIELDS = ['csrf', 'confirmation', 'expectedTotalCents', 'expectedCustomerEmail',
  'recipientReviewed', 'amountReviewed', 'datesReviewed', 'taxesReviewed'];
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});
const COPY = Object.freeze({
  fr: Object.freeze({ title: 'Révision par le propriétaire', list: 'Brouillons à examiner',
    details: 'Vérifier le brouillon immuable', customer: 'Destinataire', dates: 'Dates',
    lines: 'Articles', taxes: 'Taxes indiquées', total: 'Total calculé',
    discount: 'Rabais', lineTotal: 'Total de l’article', subtotal: 'Sous-total',
    taxTotal: 'Total des taxes', notes: 'Notes du brouillon', noTaxes: 'Aucune taxe indiquée.',
    approve: 'Approuver ce brouillon en interne seulement',
    approved: 'Approbation interne enregistrée. Aucune facture émise ou envoyée.',
    print: 'Ouvrir la version imprimable du brouillon non émis',
    empty: 'Aucun brouillon immuable à examiner.',
    notice: 'Révision interne uniquement. Ceci ne crée pas une facture Wave, un numéro de facture, un PDF officiel, un courriel ou un paiement. Les taux et l’applicabilité fiscale exigent une vérification distincte.',
    checks: ['J’ai vérifié le nom et le courriel du destinataire.',
      'J’ai vérifié les articles, rabais et le montant total.',
      'J’ai vérifié la date de facture et la date d’échéance.',
      'J’ai vérifié les taux de taxes indiqués et leur applicabilité.'],
    other: 'en', language: 'English', back: 'Tableau de bord' }),
  en: Object.freeze({ title: 'Owner review', list: 'Drafts to review',
    details: 'Review immutable draft', customer: 'Recipient', dates: 'Dates',
    lines: 'Line items', taxes: 'Specified taxes', total: 'Calculated total',
    discount: 'Discount', lineTotal: 'Line total', subtotal: 'Subtotal',
    taxTotal: 'Total tax', notes: 'Draft notes', noTaxes: 'No tax specified.',
    approve: 'Approve this draft internally only',
    approved: 'Internal approval recorded. No invoice issued or sent.',
    print: 'Open printable version of this unissued draft',
    empty: 'No immutable drafts to review.',
    notice: 'Internal review only. This does not create a Wave invoice, invoice number, official PDF, email or payment. Tax rates and applicability require separate verification.',
    checks: ['I checked the recipient name and email.',
      'I checked the items, discounts and total amount.',
      'I checked the invoice and due dates.',
      'I checked the supplied tax rates and applicability.'],
    other: 'fr', language: 'Français', back: 'Dashboard' }),
});
function send(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}
function plain(response, status) { send(response, status, 'text/plain; charset=utf-8', 'Review unavailable'); }
function page(lang, heading, content) {
  const t = COPY[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:850px;margin:auto;padding:clamp(16px,4vw,45px)}header{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}.brand{font-weight:800;letter-spacing:.08em;color:#14536b}a{color:#174b95}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #3567b7;outline-offset:3px}.panel{background:white;border:1px solid #dce5ef;border-radius:15px;padding:clamp(16px,4vw,28px);margin:20px 0;overflow-wrap:anywhere}.notice{padding:14px;border-left:4px solid #3567b7;background:#eaf1ff;border-radius:6px}li{margin:12px 0}.checks label{display:flex;align-items:flex-start;gap:12px;margin:14px 0}.checks input{width:21px;height:21px;flex-shrink:0}button{font:inherit;font-weight:700;padding:13px 18px;border:0;border-radius:9px;background:#164b9b;color:white;cursor:pointer}.line{border-top:1px solid #e7edf4;padding:9px 0;white-space:pre-wrap}.money{font-weight:800}.muted{color:#566781}
</style></head><body><main><header><div class="brand">GROUPE TAKATAK</div><nav><a href="/internal/dashboard?lang=${lang}">${t.back}</a> · <a href="/internal/review?lang=${t.other}" lang="${t.other}">${t.language}</a></nav></header><h1>${heading}</h1><p class="notice" role="note">${t.notice}</p>${content}</main></body></html>`;
}
function snapshotOf(row) {
  const p = row?.preview;
  if (!row || !UUID.test(row.id || '') || row.status !== 'DRAFT' ||
      !p || p.status !== 'DRAFT' || p.persisted !== true || p.currency !== 'CAD' ||
      !Number.isSafeInteger(p.totalCents) || p.totalCents < 0 ||
      typeof p.customer?.email !== 'string' || !Array.isArray(p.lines) || !Array.isArray(p.taxes)) {
    throw new TypeError('An immutable, calculated draft is required');
  }
  return p;
}
function csrfFor(key, token, id) {
  return crypto.createHmac('sha256', key).update('owner-internal-review-v1:')
    .update(token).update(':').update(id.toLowerCase()).digest('base64url');
}
function renderList(drafts, lang) {
  if (!drafts || drafts.status !== 'DRAFTS_ONLY' || !Array.isArray(drafts.drafts) || drafts.drafts.length > 20) {
    throw new TypeError('Bounded immutable draft listing required');
  }
  const t = COPY[lang];
  const items = drafts.drafts.map(d => {
    if (!UUID.test(d.id || '') || d.status !== 'DRAFT' || d.currency !== 'CAD') throw new TypeError('Invalid draft listing');
    return `<li><a href="/internal/review/${d.id}?lang=${lang}">${escapeHtml(d.customerName)}</a> · ${escapeHtml(money(d.totalCents, lang))} · ${escapeHtml(d.invoiceDate)}</li>`;
  }).join('');
  return page(lang, t.list, `<section class="panel">${items ? `<ul>${items}</ul>` : `<p>${t.empty}</p>`}</section>`);
}
function renderDetail(row, lang, csrf, approved = false) {
  const p = snapshotOf(row);
  const t = COPY[lang];
  const id = row.id.toLowerCase();
  const amount = cents => escapeHtml(money(cents, lang));
  const lines = p.lines.map(line => `<p class="line">${escapeHtml(line.description)} · ${line.quantity} × ${amount(line.unitPriceCents)} · ${t.discount}: ${amount(line.discountCents)} · ${t.lineTotal}: ${amount(line.lineTotalCents)}</p>`).join('');
  const taxes = p.taxes.map(tax => {
    const rate = `${Math.floor(tax.rateMilliPercent / 1000)}.${String(tax.rateMilliPercent % 1000).padStart(3, '0')}%`;
    return `<p class="line">${escapeHtml(tax.label)} (${escapeHtml(tax.code)}, ${rate}) · ${amount(tax.amountCents)}</p>`;
  }).join('');
  const names = ['recipientReviewed', 'amountReviewed', 'datesReviewed', 'taxesReviewed'];
  const checks = names.map((name, i) => `<label><input type="checkbox" name="${name}" value="yes" required>${t.checks[i]}</label>`).join('');
  const decision = approved ? `<section class="panel" role="status"><strong>${t.approved}</strong><p><a href="/internal/review/${id}/print?lang=${lang}">${t.print}</a></p></section>` :
    `<section class="panel"><form method="post" action="/internal/review/${id}?lang=${lang}" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="confirmation" value="APPROVE_DRAFT_ONLY"><input type="hidden" name="expectedTotalCents" value="${p.totalCents}"><input type="hidden" name="expectedCustomerEmail" value="${escapeHtml(p.customer.email)}"><div class="checks">${checks}</div><button type="submit">${t.approve}</button></form></section>`;
  const notes = p.notes ? `<h2>${t.notes}</h2><p class="line">${escapeHtml(p.notes)}</p>` : '';
  return page(lang, t.details, `<p><a href="/internal/review?lang=${lang}">${t.list}</a></p><section class="panel"><h2>${t.customer}</h2><p>${escapeHtml(p.customer.name)} · ${escapeHtml(p.customer.email)}</p><p>${escapeHtml(p.customer.address || '')}</p><h2>${t.dates}</h2><p>${escapeHtml(p.invoiceDate)} · ${escapeHtml(p.dueDate)}</p><h2>${t.lines}</h2>${lines}<p>${t.subtotal}: ${amount(p.subtotalCents)}</p><h2>${t.taxes}</h2>${taxes || `<p>${t.noTaxes}</p>`}<p>${t.taxTotal}: ${amount(p.taxTotalCents)}</p><p class="money">${t.total}: ${amount(p.totalCents)}</p>${notes}</section>${decision}`);
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
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const form = new URLSearchParams(text);
        if ([...form.keys()].length !== FIELDS.length ||
            FIELDS.some(field => form.getAll(field).length !== 1) ||
            [...form.keys()].some(field => !FIELDS.includes(field))) return reject(422);
        resolve(form);
      } catch { reject(400); }
    });
  });
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function attachBrowserOwnerReview(server, { origin, encryptionKeyHex, businessId, staffAuthStore, dashboardStore, draftStore, approvalStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !/^[0-9a-f]{64}$/i.test(encryptionKeyHex || '') || !businessId ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !dashboardStore || typeof dashboardStore.listDrafts !== 'function' ||
      !draftStore || typeof draftStore.getDraft !== 'function' ||
      !approvalStore || typeof approvalStore.approveDraft !== 'function') {
    throw new TypeError('Dedicated owner MFA approval dependencies required');
  }
  const key = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-internal-approval-csrf-key-v1').digest();
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const listing = url.pathname === '/internal/review';
    const item = PATH.exec(url.pathname);
    if (!listing && !item) return previous(request, response);
    if (request.method !== 'GET' && !(item && request.method === 'POST')) return plain(response, 405);
    if ([...url.searchParams.keys()].some(field => field !== 'lang' || url.searchParams.getAll(field).length !== 1) ||
        (item && !UUID.test(item[1]))) return plain(response, 422);
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
      if (listing) {
        const drafts = await dashboardStore.listDrafts({ page: 1, pageSize: 20, offset: 0 });
        return send(response, 200, 'text/html; charset=utf-8', renderList(drafts, lang));
      }
      const row = await draftStore.getDraft(item[1]);
      if (request.method === 'GET') {
        const approved = typeof approvalStore.isApproved === 'function'
          ? await approvalStore.isApproved({ draftId: row.id, ownerId: staff.id, sessionToken: token }) : false;
        return send(response, 200, 'text/html; charset=utf-8',
          renderDetail(row, lang, approved ? '' : csrfFor(key, token, row.id), approved));
      }
      const body = await readBody(request);
      const supplied = body.get('csrf');
      const expected = csrfFor(key, token, row.id);
      if (typeof supplied !== 'string' || !CSRF.test(supplied) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return plain(response, 403);
      if (body.get('confirmation') !== 'APPROVE_DRAFT_ONLY' ||
          FIELDS.slice(4).some(field => body.get(field) !== 'yes')) return plain(response, 422);
      const rawTotal = body.get('expectedTotalCents');
      if (!/^(0|[1-9][0-9]{0,12})$/.test(rawTotal || '')) return plain(response, 422);
      await approvalStore.approveDraft({ confirmation: 'APPROVE_DRAFT_ONLY', draftId: row.id,
        ownerId: staff.id, sessionToken: token, expectedTotalCents: Number(rawTotal),
        expectedCustomerEmail: body.get('expectedCustomerEmail') });
      return send(response, 200, 'text/html; charset=utf-8', renderDetail(row, lang, '', true));
    } catch (error) {
      if (error instanceof DraftApprovalError || error instanceof StoreError) {
        if ([401, 403, 404, 409, 422].includes(error.statusCode)) return plain(response, error.statusCode);
      }
      if ([400, 413, 422].includes(error)) return plain(response, error);
      return plain(response, 503);
    }
  });
  return server;
}
module.exports = { attachBrowserOwnerReview, renderList, renderDetail, csrfFor };
