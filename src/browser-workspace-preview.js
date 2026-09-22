'use strict';

const { readStaffSessionCookie } = require('./staff-session-cookie');
const { WorkspaceError } = require('./draft-workspace-store');
const { previewDraft, DraftValidationError } = require('./draft-preview');
const { escapeHtml, money } = require('./dashboard-view');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PREVIEW_PATH = /^\/internal\/workspaces\/([^/]+)\/preview$/;
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Aperçu calculé du brouillon', badge: 'APERÇU SEULEMENT · AUCUNE FACTURE ÉMISE',
    back: 'Mes brouillons', edit: 'Modifier le brouillon', other: 'en', language: 'English',
    submit: 'Préparer ce brouillon pour révision interne',
    customer: 'Client', invoiceDate: 'Date de facture', dueDate: 'Échéance',
    description: 'Description', quantity: 'Qté', unit: 'Prix unitaire', discount: 'Rabais', total: 'Total',
    subtotal: 'Sous-total', taxes: 'Taxes indiquées', taxTotal: 'Total des taxes', grand: 'Total calculé',
    noTaxes: 'Aucune taxe indiquée dans le brouillon.', notes: 'Notes', revision: 'Révision enregistrée',
    disclaimer: 'Calcul de prévisualisation, sans émission, envoi, paiement ni écriture Wave. Les taxes indiquées sont celles du brouillon : leur applicabilité et leur taux doivent être vérifiés avant toute facture réelle.',
    incomplete: 'Cet espace de travail ne contient pas encore toutes les données nécessaires au calcul (client, courriel, dates et articles). Complétez ou corrigez les champs dans l’éditeur, enregistrez, puis ouvrez à nouveau cet aperçu. Aucune taxe n’est ajoutée automatiquement.',
  }),
  en: Object.freeze({
    title: 'Calculated draft preview', badge: 'PREVIEW ONLY · NO INVOICE ISSUED',
    back: 'My drafts', edit: 'Edit working draft', other: 'fr', language: 'Français',
    submit: 'Prepare this draft for internal review',
    customer: 'Customer', invoiceDate: 'Invoice date', dueDate: 'Due date',
    description: 'Description', quantity: 'Qty', unit: 'Unit price', discount: 'Discount', total: 'Total',
    subtotal: 'Subtotal', taxes: 'Specified taxes', taxTotal: 'Total tax', grand: 'Calculated total',
    noTaxes: 'No taxes specified in this draft.', notes: 'Notes', revision: 'Saved revision',
    disclaimer: 'Calculation preview only: no issuance, sending, payment or Wave write. Taxes are taken from this draft; their applicability and rates must be verified before any real invoice.',
    incomplete: 'This workspace does not yet contain all the data required to calculate a preview (customer, email, dates and items). Complete or correct the fields in the editor, save, then open this preview again. No taxes are added automatically.',
  }),
});
const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'",
});

function page(language, workspaceId, title, inner, ownerSubmission = false) {
  const t = COPY[language];
  const edit = `/internal/editor?lang=${language}&amp;id=${workspaceId}`;
  // A link is never a submission: only the separate OWNER-only POST may freeze a workspace.
  const submitLink = ownerSubmission ? `<a href="/internal/submit/${workspaceId}?lang=${language}">${t.submit}</a>` : '';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:960px;margin:auto;padding:clamp(16px,4vw,48px)}header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:center}.brand{font-size:.85rem;font-weight:800;letter-spacing:.1em;color:#14536b}nav{display:flex;flex-wrap:wrap;gap:15px}a{color:#184b91;font-weight:700;text-underline-offset:3px}a:focus-visible{outline:3px solid #4d7dc8;outline-offset:3px}h1{font-size:clamp(1.7rem,5vw,2.7rem);line-height:1.15}.badge{display:inline-block;background:#e8f0ff;color:#214c91;border-radius:50px;padding:6px 12px;font-size:.8rem;font-weight:800}.panel{background:#fff;border:1px solid #dce5ef;border-radius:16px;padding:clamp(16px,4vw,28px);margin:18px 0}.muted,.meta{color:#53647b}.meta{font-size:.85rem}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:580px}th,td{text-align:left;border-bottom:1px solid #e7edf4;padding:12px 8px;vertical-align:top}th{font-size:.83rem;color:#53647b}.amount{text-align:right;white-space:nowrap}.totals{margin-left:auto;width:min(100%,380px)}.totals p{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e7edf4;padding:8px 0;margin:0}.total{font-size:1.2rem;font-weight:800}.notes{white-space:pre-wrap;overflow-wrap:anywhere}.notice{border-left:4px solid #3567b7;padding:14px;background:#eaf1ff;border-radius:8px}@media print{body{background:#fff}main{max-width:none;padding:0}nav{display:none}.panel{break-inside:avoid;box-shadow:none}.badge{border:1px solid #214c91}}
</style></head><body><main><header><div class="brand">GROUPE TAKATAK</div><nav aria-label="Navigation"><a href="/internal/recent-workspaces?lang=${language}">${t.back}</a><a href="${edit}">${t.edit}</a>${submitLink}<a href="/internal/workspaces/${workspaceId}/preview?lang=${t.other}" lang="${t.other}">${t.language}</a></nav></header><h1>${title}</h1><span class="badge">${t.badge}</span>${inner}<p class="notice" role="note">${t.disclaimer}</p></main></body></html>`;
}

function renderWorkspacePreview({ preview, id, revision, language = 'fr', ownerSubmission = false }) {
  if (!Object.hasOwn(COPY, language) || typeof id !== 'string' || !UUID.test(id) ||
      !Number.isSafeInteger(revision) || revision < 1 || !preview || preview.status !== 'PREVIEW_ONLY' ||
      preview.persisted !== false || preview.waveSynced !== false || preview.emailed !== false ||
      preview.currency !== 'CAD' || !Array.isArray(preview.lines) || !Array.isArray(preview.taxes) ||
      typeof ownerSubmission !== 'boolean') {
    throw new TypeError('Validated calculated preview required');
  }
  const t = COPY[language];
  const amount = cents => escapeHtml(money(String(cents), language));
  const lines = preview.lines.map(line => `<tr><td>${escapeHtml(line.description)}</td><td>${line.quantity}</td>` +
    `<td class="amount">${amount(line.unitPriceCents)}</td><td class="amount">${amount(line.discountCents)}</td>` +
    `<td class="amount">${amount(line.lineTotalCents)}</td></tr>`).join('');
  const taxes = preview.taxes.map(tax => {
    const rate = `${Math.floor(tax.rateMilliPercent / 1000)}.${String(tax.rateMilliPercent % 1000).padStart(3, '0')}%`;
    return `<p><span>${escapeHtml(tax.label)} (${escapeHtml(tax.code)}, ${rate})</span><strong>${amount(tax.amountCents)}</strong></p>`;
  }).join('');
  const customer = preview.customer;
  const inner = `<p class="meta">${t.revision} : ${revision} · CAD</p>` +
    `<section class="panel"><h2>${t.customer}</h2><strong>${escapeHtml(customer.name)}</strong><p>${escapeHtml(customer.email)}</p>` +
    (customer.address ? `<p class="notes">${escapeHtml(customer.address)}</p>` : '') +
    `<p>${t.invoiceDate} : ${escapeHtml(preview.invoiceDate)} · ${t.dueDate} : ${escapeHtml(preview.dueDate)}</p></section>` +
    `<section class="panel wrap"><table><thead><tr><th>${t.description}</th><th>${t.quantity}</th><th class="amount">${t.unit}</th><th class="amount">${t.discount}</th><th class="amount">${t.total}</th></tr></thead><tbody>${lines}</tbody></table></section>` +
    `<section class="panel totals"><p><span>${t.subtotal}</span><strong>${amount(preview.subtotalCents)}</strong></p>` +
    `<h2>${t.taxes}</h2>${taxes || `<p>${t.noTaxes}</p>`}<p><span>${t.taxTotal}</span><strong>${amount(preview.taxTotalCents)}</strong></p>` +
    `<p class="total"><span>${t.grand}</span><strong>${amount(preview.totalCents)}</strong></p></section>` +
    (preview.notes ? `<section class="panel"><h2>${t.notes}</h2><p class="notes">${escapeHtml(preview.notes)}</p></section>` : '');
  return page(language, id, t.title, inner, ownerSubmission);
}

function send(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}

// GET only; the storage layer verifies a live, business-scoped, original-owner session.
// Never accept an admin key or browser bearer token, and never write invoice data.
function attachBrowserWorkspacePreview(server, { origin, workspaceStore, staffAuthStore = null }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !workspaceStore || typeof workspaceStore.load !== 'function' ||
      (staffAuthStore !== null && typeof staffAuthStore.getSession !== 'function')) {
    throw new TypeError('Dedicated HTTPS origin and private workspace store required');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const match = PREVIEW_PATH.exec(url.pathname);
    if (!match) return previous(request, response);
    if (request.method !== 'GET') return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (!UUID.test(match[1]) || [...url.searchParams.keys()].some(key => key !== 'lang' || url.searchParams.getAll(key).length !== 1)) {
      return send(response, 422, 'text/plain; charset=utf-8', 'Invalid request');
    }
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, language)) return send(response, 422, 'text/plain; charset=utf-8', 'Invalid language');
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) {
      return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return send(response, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    try {
      const row = await workspaceStore.load({ token, workspaceId: match[1] });
      if (!row || typeof row.id !== 'string' || row.id.toLowerCase() !== match[1].toLowerCase() ||
          row.status !== 'WORK_IN_PROGRESS' || row.invoiceIssued !== false || row.emailed !== false) {
        return send(response, 503, 'text/plain; charset=utf-8', 'Preview unavailable');
      }
      let preview;
      try { preview = previewDraft(row.content); }
      catch (error) {
        if (!(error instanceof DraftValidationError)) throw error;
        const t = COPY[language];
        const html = page(language, match[1], t.title,
          `<section class="panel" role="status"><h2>${t.title}</h2><p>${t.incomplete}</p></section>`);
        return send(response, 422, 'text/html; charset=utf-8', html);
      }
      const staff = staffAuthStore ? await staffAuthStore.getSession(token) : null;
      return send(response, 200, 'text/html; charset=utf-8',
        renderWorkspacePreview({ preview, id: match[1], revision: row.revision,
          language, ownerSubmission: Boolean(staff && staff.role === 'OWNER') }));
    } catch (error) {
      if (error instanceof WorkspaceError && [401, 404, 422].includes(error.statusCode)) {
        return send(response, error.statusCode, 'text/plain; charset=utf-8', 'Preview unavailable');
      }
      return send(response, 503, 'text/plain; charset=utf-8', 'Preview unavailable');
    }
  });
  return server;
}

module.exports = { attachBrowserWorkspacePreview, renderWorkspacePreview };
