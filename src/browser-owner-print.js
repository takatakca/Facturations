'use strict';

// Browser print / Save as PDF is deliberately NOT an issued invoice or a stored PDF.
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { escapeHtml, money } = require('./dashboard-view');
const { previewDraft } = require('./draft-preview');

const PATH = /^\/internal\/review\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/print$/i;
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'",
});
const COPY = Object.freeze({
  fr: Object.freeze({ title: 'Brouillon approuvé en interne', banner: 'BROUILLON NON ÉMIS',
    secondary: 'Document de travail · ne constitue pas une facture', reference: 'Référence interne du brouillon',
    recipient: 'Destinataire', dates: 'Dates envisagées', date: 'Date', due: 'Échéance',
    description: 'Description', qty: 'Qté', unit: 'Prix unitaire', discount: 'Rabais', lineTotal: 'Total',
    subtotal: 'Sous-total', taxes: 'Taxes saisies', taxTotal: 'Total des taxes', total: 'Total calculé',
    notes: 'Notes', emptyTax: 'Aucune taxe saisie',
    disclaimer: 'Approbation interne seulement. Aucun numéro de facture officielle, aucune émission, aucun envoi, aucun paiement. Vérifiez les taxes avant toute émission future.',
    instruction: 'Pour conserver ce brouillon : utilisez Imprimer puis Enregistrer en PDF dans votre navigateur. Cette copie n’est pas un PDF de facture officielle archivé.',
    back: 'Retour à la révision' }),
  en: Object.freeze({ title: 'Internally approved draft', banner: 'UNISSUED DRAFT',
    secondary: 'Working document · not an invoice', reference: 'Internal draft reference',
    recipient: 'Recipient', dates: 'Proposed dates', date: 'Date', due: 'Due',
    description: 'Description', qty: 'Qty', unit: 'Unit price', discount: 'Discount', lineTotal: 'Total',
    subtotal: 'Subtotal', taxes: 'Entered taxes', taxTotal: 'Total tax', total: 'Calculated total',
    notes: 'Notes', emptyTax: 'No tax entered',
    disclaimer: 'Internal approval only. No official invoice number, issuance, email or payment. Verify taxes before any future issuance.',
    instruction: 'To keep a copy, use Print then Save as PDF in your browser. This is not an archived official invoice PDF.',
    back: 'Back to review' }),
});
function reply(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}
function deny(response, status) { reply(response, status, 'text/plain; charset=utf-8', 'Print view unavailable'); }

function validatedSnapshot(row) {
  const p = row?.preview;
  if (!row || !PATH.test(`/internal/review/${row.id}/print`) || row.status !== 'DRAFT' ||
    !p || p.status !== 'DRAFT' || p.persisted !== true || p.currency !== 'CAD' ||
    !Array.isArray(p.lines) || !Array.isArray(p.taxes)) throw new TypeError('Immutable draft required');
  const calculated = previewDraft({ currency: p.currency, customer: p.customer,
    invoiceDate: p.invoiceDate, dueDate: p.dueDate, notes: p.notes,
    lines: p.lines.map(line => ({ description: line.description, quantity: line.quantity,
      unitPriceCents: line.unitPriceCents, discountCents: line.discountCents, taxable: line.taxable })),
    taxes: p.taxes.map(tax => ({ code: tax.code, label: tax.label, rateMilliPercent: tax.rateMilliPercent })) });
  for (const key of ['subtotalCents', 'taxableSubtotalCents', 'taxTotalCents', 'totalCents']) {
    if (p[key] !== calculated[key]) throw new TypeError('Draft totals mismatch');
  }
  for (let index = 0; index < calculated.lines.length; index++) {
    if (p.lines[index].lineTotalCents !== calculated.lines[index].lineTotalCents) throw new TypeError('Line total mismatch');
  }
  for (let index = 0; index < calculated.taxes.length; index++) {
    if (p.taxes[index].amountCents !== calculated.taxes[index].amountCents) throw new TypeError('Tax total mismatch');
  }
  return calculated;
}

function renderPrintable(row, language) {
  if (!Object.hasOwn(COPY, language)) throw new TypeError('Unsupported language');
  const p = validatedSnapshot(row);
  const t = COPY[language];
  const e = escapeHtml;
  const cash = cents => e(money(cents, language));
  const rows = p.lines.map(line => `<tr><td>${e(line.description)}</td><td class="num">${line.quantity}</td><td class="num">${cash(line.unitPriceCents)}</td><td class="num">${cash(line.discountCents)}</td><td class="num">${cash(line.lineTotalCents)}</td></tr>`).join('');
  const taxes = p.taxes.map(tax => `<tr><th scope="row">${e(tax.label)} (${e(tax.code)}) · ${Math.floor(tax.rateMilliPercent / 1000)}.${String(tax.rateMilliPercent % 1000).padStart(3, '0')}%</th><td>${cash(tax.amountCents)}</td></tr>`).join('');
  const note = p.notes ? `<section><h2>${t.notes}</h2><p class="preserve">${e(p.notes)}</p></section>` : '';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.banner} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#182638;background:#eef2f8}*{box-sizing:border-box}body{margin:0;line-height:1.48}main{position:relative;z-index:1;max-width:860px;margin:32px auto;padding:40px;background:#fff;border:1px solid #dbe3ee}header{border-bottom:3px solid #123f74;padding-bottom:22px}header strong{letter-spacing:.12em;color:#123f74}.banner{font-size:1.25rem;font-weight:900;letter-spacing:.1em;border:3px solid #8a2633;color:#8a2633;padding:12px;margin:22px 0;text-align:center}.muted{color:#43556c}.meta{display:grid;grid-template-columns:1fr 1fr;gap:20px}h1{font-size:1.6rem;margin-bottom:5px}h2{font-size:1rem;margin-top:28px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #cbd7e6;vertical-align:top;overflow-wrap:anywhere}th{color:#203b5d}td.num{text-align:right;white-space:nowrap}table.financial{width:min(100%,450px);margin-left:auto}.financial td{text-align:right}.financial th{font-weight:600}.total{font-weight:900;border-top:2px solid #183f70}.preserve{white-space:pre-wrap;overflow-wrap:anywhere}.notice{border:2px solid #8a2633;padding:14px;margin-top:25px;font-weight:700}.tools{margin:18px 0;padding:12px;background:#edf4ff}a{color:#164b9b}a:focus-visible{outline:3px solid #164b9b;outline-offset:3px}.watermark{display:none}@media(max-width:650px){main{padding:18px;margin:0}.meta{grid-template-columns:1fr}table.items{display:block;overflow-x:auto}}@page{size:A4;margin:15mm}@media print{html,body{background:#fff;print-color-adjust:exact;-webkit-print-color-adjust:exact}main{border:0;max-width:none;padding:0;margin:0}.tools{display:none}.watermark{display:block;position:fixed;top:42%;left:3%;width:94%;font-size:48pt;line-height:1.2;text-align:center;transform:rotate(-24deg);color:rgba(100,35,45,.18);z-index:0;font-weight:900;pointer-events:none}header,.banner,.meta,.notice,section,table tr{break-inside:avoid}.banner{border-color:#8a2633!important;color:#8a2633!important}table.items{display:table;overflow:visible}thead{display:table-header-group}}
</style></head><body><div class="watermark" aria-hidden="true">${t.banner}</div><main><div class="tools"><a href="/internal/review/${row.id}?lang=${language}">${t.back}</a><p>${t.instruction}</p></div><header><strong>GROUPE TAKATAK</strong><h1>${t.title}</h1><p class="muted">${t.secondary}</p></header><div class="banner">${t.banner}</div><p><strong>${t.reference}:</strong> ${e(row.id)}</p><div class="meta"><section><h2>${t.recipient}</h2><p>${e(p.customer.name)}<br>${e(p.customer.email)}</p><p class="preserve">${e(p.customer.address || '')}</p></section><section><h2>${t.dates}</h2><p>${t.date}: ${e(p.invoiceDate)}<br>${t.due}: ${e(p.dueDate)}</p></section></div><section><table class="items"><thead><tr><th scope="col">${t.description}</th><th scope="col">${t.qty}</th><th scope="col">${t.unit}</th><th scope="col">${t.discount}</th><th scope="col">${t.lineTotal}</th></tr></thead><tbody>${rows}</tbody></table></section><table class="financial"><tbody><tr><th scope="row">${t.subtotal}</th><td>${cash(p.subtotalCents)}</td></tr>${taxes || `<tr><th scope="row">${t.taxes}</th><td>${t.emptyTax}</td></tr>`}<tr><th scope="row">${t.taxTotal}</th><td>${cash(p.taxTotalCents)}</td></tr><tr class="total"><th scope="row">${t.total} (CAD)</th><td>${cash(p.totalCents)}</td></tr></tbody></table>${note}<p class="notice">${t.disclaimer}</p></main></body></html>`;
}

function attachBrowserOwnerPrint(server, { origin, businessId, staffAuthStore, draftStore, approvalStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && new URL(origin).protocol === 'https:' && new URL(origin).origin === origin; }
  catch { /* Invalid origin: fail closed before modifying listeners. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
    !validOrigin || !businessId || !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
    !draftStore || typeof draftStore.getDraft !== 'function' ||
    !approvalStore || typeof approvalStore.isApproved !== 'function') {
    throw new TypeError('Private OWNER print dependencies required');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const match = PATH.exec(url.pathname);
    if (!match) return previous(request, response);
    if (request.method !== 'GET') return deny(response, 405);
    if ([...url.searchParams.keys()].some(key => key !== 'lang' || url.searchParams.getAll(key).length !== 1)) return deny(response, 422);
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, language) || url.hash) return deny(response, 422);
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return deny(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return deny(response, 401);
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return deny(response, 401);
      if (staff.role !== 'OWNER') return deny(response, 403);
      const approved = await approvalStore.isApproved({ draftId: match[1], ownerId: staff.id, sessionToken: token });
      if (!approved) return deny(response, 409);
      const row = await draftStore.getDraft(match[1]);
      return reply(response, 200, 'text/html; charset=utf-8', renderPrintable(row, language));
    } catch { return deny(response, 503); }
  });
  return server;
}

module.exports = { attachBrowserOwnerPrint, renderPrintable };
