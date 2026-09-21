'use strict';

// Server-side presentation only. No client-side credentials, scripts or external assets.
// The HTTP caller MUST authorize the tenant before fetching data or calling this renderer.
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Tableau de bord', subtitle: 'Facturations · GROUPE TAKATAK',
    draftOnly: 'Brouillons seulement · aucune facture émise',
    drafts: 'Brouillons', customers: 'Clients', amount: 'Montant des brouillons',
    notice: 'Ces montants ne sont ni des revenus, ni des paiements reçus.',
    recent: 'Brouillons récents', customer: 'Client', invoiceDate: 'Date de facture',
    dueDate: 'Échéance', total: 'Total', status: 'État', empty: 'Aucun brouillon pour le moment.',
    draft: 'Brouillon', logout: 'Se déconnecter', editor: 'Nouveau brouillon de travail',
    savedWorkspaces: 'Mes brouillons enregistrés',
    footer: 'Lecture seule. Aucune émission, aucun courriel, aucun paiement.',
  }),
  en: Object.freeze({
    title: 'Dashboard', subtitle: 'Invoicing · GROUPE TAKATAK',
    draftOnly: 'Drafts only · no invoices issued',
    drafts: 'Drafts', customers: 'Customers', amount: 'Draft amount',
    notice: 'These amounts are not revenue or payments received.',
    recent: 'Recent drafts', customer: 'Customer', invoiceDate: 'Invoice date',
    dueDate: 'Due date', total: 'Total', status: 'Status', empty: 'No drafts yet.',
    draft: 'Draft', logout: 'Sign out', editor: 'New working draft',
    savedWorkspaces: 'My saved drafts',
    footer: 'Read-only. No issuance, email or payment.',
  }),
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function count(value) {
  const raw = String(value ?? '');
  if (!/^\d{1,20}$/.test(raw)) return '—';
  return BigInt(raw).toString();
}

function money(value, locale) {
  const raw = String(value ?? '');
  if (!/^\d{1,22}$/.test(raw)) return '—';
  const cents = BigInt(raw);
  const whole = (cents / 100n).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'fr' ? '\u202f' : ',');
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return locale === 'fr' ? `${grouped},${fraction}\u00a0$ CA` : `CA$${grouped}.${fraction}`;
}

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? escapeHtml(value) : '—';
}

function renderDashboard({ summary, drafts, language = 'fr' }) {
  if (!summary || summary.status !== 'DRAFTS_ONLY' || !drafts ||
      drafts.status !== 'DRAFTS_ONLY' || !Array.isArray(drafts.drafts) || drafts.drafts.length > 50) {
    throw new TypeError('Draft-only dashboard data required');
  }
  if (!['fr', 'en'].includes(language)) throw new TypeError('Unsupported dashboard language');
  const t = COPY[language];
  const rows = drafts.drafts.map(item => {
    if (!item || item.status !== 'DRAFT' || item.currency !== 'CAD') {
      throw new TypeError('Draft-only rows required');
    }
    return `<tr><td>${escapeHtml(item.customerName)}</td><td>${date(item.invoiceDate)}</td>` +
      `<td>${date(item.dueDate)}</td><td class="numeric">${escapeHtml(money(item.totalCents, language))}</td>` +
      `<td><span class="pill">${t.draft}</span></td></tr>`;
  }).join('');
  const content = rows || `<tr><td colspan="5" class="empty">${t.empty}</td></tr>`;
  // The only form is POST to the existing same-origin, origin-checked logout route.
  // The navigation links contain no tokens or customer data; their targets recheck live sessions.
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f6fa;color:#152338}
*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:1160px;margin:auto;padding:clamp(18px,4vw,52px)}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;margin-bottom:32px}
.brand{font-weight:800;letter-spacing:.08em;font-size:.83rem;color:#14536b}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.1;margin:8px 0}
p{margin:0}.muted{color:#52647c}.tag,.pill{display:inline-block;border-radius:999px;padding:5px 12px;background:#e5f5ed;color:#0e5d38;font-weight:650;font-size:.82rem}
.tag{background:#e8f0ff;color:#224a91}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.actions form{margin:0}
.signout,.editor-link{font:inherit;font-weight:700;font-size:.88rem;color:#173e76;background:white;border:1px solid #b7c8df;border-radius:9px;padding:10px 14px;cursor:pointer}.editor-link{text-decoration:none;background:#164b9b;color:white;border-color:#164b9b}.saved-link{text-decoration:none;font-size:.88rem;font-weight:700;color:#173e76;border:1px solid #b7c8df;border-radius:9px;padding:10px 14px;background:white}
.signout:hover,.saved-link:hover{background:#edf3fc}.editor-link:hover{background:#103a88}.signout:focus-visible,.editor-link:focus-visible,.saved-link:focus-visible{outline:3px solid #3567b7;outline-offset:3px}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:26px 0}
.metric,.panel{background:white;border:1px solid #dce5ef;border-radius:18px;box-shadow:0 4px 18px rgba(12,28,48,.04)}
.metric{padding:24px}.metric .label{color:#52647c;font-size:.92rem}.metric strong{display:block;font-size:clamp(1.4rem,3vw,2rem);overflow-wrap:anywhere;margin-top:7px;font-variant-numeric:tabular-nums}
.notice{padding:14px 18px;margin-bottom:25px;border-left:4px solid #3567b7;border-radius:8px;background:#eaf1ff;color:#234576}
.panel{overflow:hidden}.panel h2{font-size:1.2rem;margin:0;padding:22px 24px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:650px;text-align:left}
th,td{padding:14px 22px;border-top:1px solid #e9eef5}th{font-size:.81rem;text-transform:uppercase;letter-spacing:.03em;color:#52647c;background:#f9fbfd}
td{overflow-wrap:anywhere}td.numeric{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th.numeric{text-align:right}.empty{text-align:center;color:#52647c;padding:36px}
footer{color:#52647c;font-size:.83rem;padding:24px 0}@media(max-width:700px){.metrics{grid-template-columns:1fr}.metric{padding:18px}th,td{padding:12px 15px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important}}
</style></head><body><main>
<header><div><p class="brand">GROUPE TAKATAK</p><h1>${t.title}</h1><p class="muted">${t.subtitle}</p></div><div class="actions"><span class="tag">${t.draftOnly}</span><a class="editor-link" href="/internal/editor?lang=${language}">${t.editor}</a><a class="saved-link" href="/internal/recent-workspaces?lang=${language}">${t.savedWorkspaces}</a><form method="post" action="/internal/logout?lang=${language}"><button class="signout" type="submit">${t.logout}</button></form></div></header>
<section class="metrics" aria-label="${t.title}">
<div class="metric"><span class="label">${t.drafts}</span><strong>${escapeHtml(count(summary.draftCount))}</strong></div>
<div class="metric"><span class="label">${t.customers}</span><strong>${escapeHtml(count(summary.customerCount))}</strong></div>
<div class="metric"><span class="label">${t.amount}</span><strong>${escapeHtml(money(summary.draftTotalCents, language))}</strong></div>
</section><p class="notice" role="note">${t.notice}</p>
<section class="panel" aria-labelledby="drafts-title"><h2 id="drafts-title">${t.recent}</h2><div class="scroll" role="region" aria-label="${t.recent}" tabindex="0"><table><thead><tr><th scope="col">${t.customer}</th><th scope="col">${t.invoiceDate}</th><th scope="col">${t.dueDate}</th><th scope="col" class="numeric">${t.total}</th><th scope="col">${t.status}</th></tr></thead><tbody>${content}</tbody></table></div></section>
<footer>${t.footer}</footer></main></body></html>`;
}

module.exports = { renderDashboard, escapeHtml, money };
