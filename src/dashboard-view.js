'use strict';

// Server-side presentation only. No client-side credentials or external assets.
// The HTTP caller MUST authorize the tenant before fetching data or calling this renderer.
const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Tableau de bord', subtitle: 'Facturations · GROUPE TAKATAK',
    product: 'FACTURATIONS', workspace: 'Espace de gestion',
    draftOnly: 'Brouillons seulement · aucune facture émise',
    drafts: 'Brouillons', customers: 'Clients', amount: 'Montant des brouillons',
    notice: 'Ces montants ne sont ni des revenus, ni des paiements reçus.',
    recent: 'Brouillons récents', customer: 'Client', invoiceDate: 'Date de facture',
    dueDate: 'Échéance', total: 'Total', status: 'État', empty: 'Aucun brouillon pour le moment.',
    draft: 'Brouillon', logout: 'Se déconnecter', editor: 'Nouveau brouillon de travail',
    savedWorkspaces: 'Mes brouillons enregistrés', review: 'Réviser les brouillons',
    directory: 'Répertoire clients', assistant: 'Assistant IA', help: 'Aide / Tutoriel', language: 'English',
    quickTitle: 'Commencer rapidement',
    quickText: 'Créez un brouillon, retrouvez un travail sauvegardé ou ouvrez les outils réservés au propriétaire.',
    footer: 'Lecture seule. Aucune émission, aucun courriel, aucun paiement.',
    tourLabel: 'Tutoriel Facturations', tourPlaceholder: 'Chargement du tutoriel…',
    back: 'Retour', next: 'Suivant', skip: 'Passer le tutoriel',
  }),
  en: Object.freeze({
    title: 'Dashboard', subtitle: 'Invoicing · GROUPE TAKATAK',
    product: 'FACTURATIONS', workspace: 'Management workspace',
    draftOnly: 'Drafts only · no invoices issued',
    drafts: 'Drafts', customers: 'Customers', amount: 'Draft amount',
    notice: 'These amounts are not revenue or payments received.',
    recent: 'Recent drafts', customer: 'Customer', invoiceDate: 'Invoice date',
    dueDate: 'Due date', total: 'Total', status: 'Status', empty: 'No drafts yet.',
    draft: 'Draft', logout: 'Sign out', editor: 'New working draft',
    savedWorkspaces: 'My saved drafts', review: 'Review drafts',
    directory: 'Customer directory', assistant: 'AI Assistant', help: 'Help / Tutorial', language: 'Français',
    quickTitle: 'Quick start',
    quickText: 'Create a draft, resume saved work, or open owner-only tools when your role allows it.',
    footer: 'Read-only. No issuance, email or payment.',
    tourLabel: 'Facturations tutorial', tourPlaceholder: 'Loading tutorial…',
    back: 'Back', next: 'Next', skip: 'Skip tutorial',
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

function renderDashboard({ summary, drafts, language = 'fr', ownerReview = false, assistantAvailable = false }) {
  if (!summary || summary.status !== 'DRAFTS_ONLY' || !drafts ||
      drafts.status !== 'DRAFTS_ONLY' || !Array.isArray(drafts.drafts) || drafts.drafts.length > 50 ||
      typeof ownerReview !== 'boolean' || typeof assistantAvailable !== 'boolean') {
    throw new TypeError('Draft-only dashboard data required');
  }
  if (!['fr', 'en'].includes(language)) throw new TypeError('Unsupported dashboard language');
  const t = COPY[language];
  const otherLanguage = language === 'fr' ? 'en' : 'fr';
  const rows = drafts.drafts.map(item => {
    if (!item || item.status !== 'DRAFT' || item.currency !== 'CAD') {
      throw new TypeError('Draft-only rows required');
    }
    return `<tr><td>${escapeHtml(item.customerName)}</td><td>${date(item.invoiceDate)}</td>` +
      `<td>${date(item.dueDate)}</td><td class="numeric">${escapeHtml(money(item.totalCents, language))}</td>` +
      `<td><span class="pill">${t.draft}</span></td></tr>`;
  }).join('');
  const content = rows || `<tr><td colspan="5" class="empty">${t.empty}</td></tr>`;

  // Only live OWNER sessions on configured private installations receive these navigation links.
  // The review and customer-directory routes independently check cookie, OWNER and tenant.
  const ownerNav = ownerReview
    ? `<a class="nav-link" href="/internal/customers?lang=${language}">${t.directory}</a>
       <a class="nav-link" href="/internal/review?lang=${language}">${t.review}</a>`
    : '';
  const ownerQuick = ownerReview
    ? `<a class="quick-card" data-guide-id="customers" href="/internal/customers?lang=${language}"><strong>${t.directory}</strong><span>${language === 'fr' ? 'Consulter et gérer les fiches clients autorisées.' : 'View and manage authorized customer records.'}</span></a>
       <a class="quick-card" data-guide-id="review" href="/internal/review?lang=${language}"><strong>${t.review}</strong><span>${language === 'fr' ? 'Vérifier les brouillons soumis avant toute émission.' : 'Review submitted drafts before any issuance.'}</span></a>`
    : '';
  const assistantNav = assistantAvailable
    ? `<a class="nav-link" href="/internal/assistant?lang=${language}">${t.assistant}</a>`
    : '';
  const assistantQuick = assistantAvailable
    ? `<a class="quick-card" href="/internal/assistant?lang=${language}"><strong>${t.assistant}</strong><span>${language === 'fr' ? 'Poser une question ou préparer un brouillon avec OpenAI, sans exécuter d’action financière.' : 'Ask a question or prepare a draft with OpenAI, without executing a financial action.'}</span></a>`
    : '';

  // The only form is POST to the existing same-origin, origin-checked logout route.
  // Navigation links contain no tokens or customer data; targets recheck live sessions.
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f7;color:#122033}
*{box-sizing:border-box}body{margin:0;line-height:1.5;background:linear-gradient(180deg,#f7f9fc 0,#eef2f7 42%,#f7f9fc 100%);min-height:100vh}
a{color:inherit}.app-shell{min-height:100vh}.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px clamp(18px,4vw,42px);background:rgba(255,255,255,.95);border-bottom:1px solid #dde5ef;backdrop-filter:blur(14px)}
.brand-wrap{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:#102b4f;color:#fff;font-weight:900;letter-spacing:.03em}.brand{font-weight:900;letter-spacing:.09em;font-size:.78rem;color:#102b4f}.workspace{color:#66758b;font-size:.78rem;margin-top:2px}
.top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.top-link,.help-button,.signout{font:inherit;font-weight:750;font-size:.84rem;border:1px solid #ccd7e4;border-radius:10px;padding:9px 12px;background:#fff;color:#183b68;text-decoration:none;cursor:pointer}.help-button{background:#102b4f;color:#fff;border-color:#102b4f}.top-link:focus-visible,.help-button:focus-visible,.signout:focus-visible,.nav-link:focus-visible,.quick-card:focus-visible,.editor-link:focus-visible{outline:3px solid #4c75b9;outline-offset:3px}
.layout{display:grid;grid-template-columns:240px minmax(0,1fr);max-width:1440px;margin:0 auto}.sidebar{padding:30px 18px 30px 28px}.sidebar-inner{position:sticky;top:86px;display:grid;gap:8px}.nav-label{font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;color:#7b8798;margin:0 10px 4px}.nav-link{display:flex;text-decoration:none;font-weight:750;color:#30445f;padding:11px 12px;border-radius:11px}.nav-link:hover{background:#fff}.nav-link.active{background:#102b4f;color:#fff}
main{min-width:0;padding:34px clamp(18px,4vw,48px) 52px 18px}.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-bottom:24px}.eyebrow{font-size:.76rem;font-weight:850;letter-spacing:.1em;color:#56718e;text-transform:uppercase}.hero h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.02;margin:6px 0 8px}.hero p{margin:0;color:#607086}.tag,.pill{display:inline-block;border-radius:999px;padding:5px 12px;background:#e6f4ed;color:#11603b;font-weight:750;font-size:.8rem}.tag{background:#e7eef9;color:#244c83}
.hero-actions{display:flex;gap:10px;flex-wrap:wrap}.editor-link{display:inline-flex;align-items:center;text-decoration:none;background:#102b4f;color:#fff;border:1px solid #102b4f;border-radius:11px;padding:11px 15px;font-weight:800}.secondary-link{display:inline-flex;align-items:center;text-decoration:none;background:#fff;color:#183b68;border:1px solid #ccd7e4;border-radius:11px;padding:11px 15px;font-weight:800}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:22px 0}.metric,.panel,.quick-panel{background:rgba(255,255,255,.96);border:1px solid #dce4ee;border-radius:18px;box-shadow:0 12px 30px rgba(31,49,74,.055)}.metric{padding:22px}.metric .label{color:#6a788b;font-size:.9rem}.metric strong{display:block;font-size:clamp(1.55rem,3vw,2.2rem);overflow-wrap:anywhere;margin-top:7px;font-variant-numeric:tabular-nums}.metric small{display:block;margin-top:7px;color:#8a96a6}
.notice{padding:14px 17px;margin:0 0 22px;border-left:4px solid #3567b7;border-radius:9px;background:#eaf1ff;color:#234576}.quick-panel{padding:22px;margin-bottom:22px}.quick-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.quick-heading h2{margin:0;font-size:1.1rem}.quick-heading p{margin:4px 0 0;color:#6a788b;font-size:.92rem}.quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.quick-card{display:flex;flex-direction:column;gap:5px;text-decoration:none;padding:16px;border:1px solid #dce4ee;border-radius:14px;background:#fbfcfe}.quick-card:hover{border-color:#aac0dd;background:#fff}.quick-card strong{color:#17385f}.quick-card span{color:#6b7889;font-size:.88rem}
.panel{overflow:hidden}.panel-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 22px}.panel h2{font-size:1.15rem;margin:0}.panel-header span{font-size:.82rem;color:#768397}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:650px;text-align:left}th,td{padding:14px 22px;border-top:1px solid #e9eef5}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#657489;background:#f9fbfd}td{overflow-wrap:anywhere}td.numeric{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}th.numeric{text-align:right}.empty{text-align:center;color:#52647c;padding:40px}
footer{color:#758296;font-size:.82rem;padding:24px 0}.tour{border:0;border-radius:18px;padding:0;max-width:min(520px,calc(100vw - 32px));box-shadow:0 28px 80px rgba(13,29,52,.28)}.tour::backdrop{background:rgba(9,20,36,.48);backdrop-filter:blur(2px)}.tour-card{padding:24px}.tour-counter{font-size:.76rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6d7c90}.tour h2{margin:7px 0 10px;font-size:1.45rem}.tour p{margin:0;color:#52647c}.tour-actions{display:flex;justify-content:space-between;gap:10px;margin-top:22px;flex-wrap:wrap}.tour-actions .group{display:flex;gap:8px}.tour-actions button{font:inherit;font-weight:800;border:1px solid #c9d5e3;border-radius:10px;padding:10px 13px;background:#fff;color:#173e76;cursor:pointer}.tour-actions .primary{background:#102b4f;color:#fff;border-color:#102b4f}.tour-actions button:disabled{opacity:.45;cursor:not-allowed}
[data-guide-active="true"]{outline:4px solid #80a7dc;outline-offset:4px;border-radius:14px}
@media(max-width:980px){.layout{grid-template-columns:1fr}.sidebar{display:none}main{padding:26px clamp(16px,4vw,30px)}.hero{align-items:flex-start;flex-direction:column}.quick-grid{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.topbar{align-items:flex-start}.brand-wrap{min-width:0}.top-actions{gap:6px}.metrics,.quick-grid{grid-template-columns:1fr}.metric{padding:18px}.hero-actions{width:100%}.editor-link,.secondary-link{flex:1;justify-content:center}.panel-header{align-items:flex-start;flex-direction:column}th,td{padding:12px 15px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style><script src="/internal/dashboard-guide.js" defer></script></head><body><div class="app-shell">
<header class="topbar"><div class="brand-wrap"><div class="brand-mark" aria-hidden="true">T</div><div><div class="brand">GROUPE TAKATAK · ${t.product}</div><div class="workspace">${t.workspace}</div></div></div>
<div class="top-actions"><a class="top-link" href="/internal/dashboard?lang=${otherLanguage}" lang="${otherLanguage}">${t.language}</a><button class="help-button" id="tour-open" type="button">${t.help}</button><form method="post" action="/internal/logout?lang=${language}"><button class="signout" type="submit">${t.logout}</button></form></div></header>
<div class="layout"><aside class="sidebar" aria-label="${t.product}"><nav class="sidebar-inner"><p class="nav-label">${t.product}</p><a class="nav-link active" href="/internal/dashboard?lang=${language}" aria-current="page">${t.title}</a><a class="nav-link" href="/internal/editor?lang=${language}">${t.editor}</a><a class="nav-link" href="/internal/recent-workspaces?lang=${language}">${t.savedWorkspaces}</a>${ownerNav}${assistantNav}</nav></aside>
<main><section class="hero"><div><div class="eyebrow">${t.subtitle}</div><h1>${t.title}</h1><p>${t.quickText}</p></div><div class="hero-actions"><span class="tag">${t.draftOnly}</span><a class="editor-link" data-guide-id="new-draft" href="/internal/editor?lang=${language}">${t.editor}</a><a class="secondary-link" data-guide-id="saved-drafts" href="/internal/recent-workspaces?lang=${language}">${t.savedWorkspaces}</a></div></section>
<section class="metrics" data-guide-id="overview" aria-label="${t.title}"><div class="metric"><span class="label">${t.drafts}</span><strong>${escapeHtml(count(summary.draftCount))}</strong><small>${t.draftOnly}</small></div><div class="metric"><span class="label">${t.customers}</span><strong>${escapeHtml(count(summary.customerCount))}</strong><small>${t.notice}</small></div><div class="metric"><span class="label">${t.amount}</span><strong>${escapeHtml(money(summary.draftTotalCents, language))}</strong><small>${t.notice}</small></div></section>
<p class="notice" role="note">${t.notice}</p>
<section class="quick-panel" aria-labelledby="quick-title"><div class="quick-heading"><div><h2 id="quick-title">${t.quickTitle}</h2><p>${t.quickText}</p></div></div><div class="quick-grid"><a class="quick-card" href="/internal/editor?lang=${language}"><strong>${t.editor}</strong><span>${language === 'fr' ? 'Préparer une nouvelle facture sans rien émettre.' : 'Prepare a new invoice without issuing anything.'}</span></a><a class="quick-card" href="/internal/recent-workspaces?lang=${language}"><strong>${t.savedWorkspaces}</strong><span>${language === 'fr' ? 'Reprendre un brouillon déjà enregistré.' : 'Resume a previously saved draft.'}</span></a>${ownerQuick}${assistantQuick}</div></section>
<section class="panel" aria-labelledby="drafts-title"><div class="panel-header"><h2 id="drafts-title">${t.recent}</h2><span>${t.draftOnly}</span></div><div class="scroll" role="region" aria-label="${t.recent}" tabindex="0"><table><thead><tr><th scope="col">${t.customer}</th><th scope="col">${t.invoiceDate}</th><th scope="col">${t.dueDate}</th><th scope="col" class="numeric">${t.total}</th><th scope="col">${t.status}</th></tr></thead><tbody>${content}</tbody></table></div></section>
<footer>${t.footer}</footer></main></div>
<dialog class="tour" id="product-tour" aria-labelledby="tour-title"><div class="tour-card"><div class="tour-counter" id="tour-counter">${t.tourLabel}</div><h2 id="tour-title">${t.tourLabel}</h2><p id="tour-text">${t.tourPlaceholder}</p><div class="tour-actions"><button id="tour-skip" type="button">${t.skip}</button><div class="group"><button id="tour-back" type="button">${t.back}</button><button class="primary" id="tour-next" type="button">${t.next}</button></div></div></div></dialog>
</div></body></html>`;
}

module.exports = { renderDashboard, escapeHtml, money };
