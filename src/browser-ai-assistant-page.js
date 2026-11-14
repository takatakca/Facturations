'use strict';

const { readStaffSessionCookie } = require('./staff-session-cookie');

const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Assistant Facturations',
    eyebrow: 'OpenAI · aide et préparation',
    intro: 'Posez une question ou préparez un brouillon. L’assistant ne peut jamais émettre, envoyer, publier, payer ou modifier une facture sans le parcours normal de Facturations.',
    helpMode: 'Aide',
    draftMode: 'Préparer un brouillon',
    placeholderHelp: 'Ex. Comment créer un brouillon de facture?',
    placeholderDraft: 'Ex. Prépare un brouillon pour Client ABC, service de nettoyage 850 $, sans taxes, facture du 27 septembre 2026, payable le 12 octobre 2026, courriel client@example.com.',
    send: 'Envoyer',
    back: 'Tableau de bord',
    language: 'English',
    quick: 'Suggestions',
    help1: 'Comment créer un brouillon?',
    help2: 'Quelle est la différence entre un brouillon et une facture émise?',
    draft1: 'Prépare un brouillon de facture à partir de ma description.',
    working: 'Réponse en cours…',
    blocked: 'La demande a été bloquée par les contrôles de sécurité. Reformulez-la sans demander d’action financière ou irréversible.',
    unavailable: 'L’assistant est temporairement indisponible. Facturations continue de fonctionner normalement sans IA.',
    clarify: 'Informations manquantes :',
    preview: 'Aperçu du brouillon',
    previewOnly: 'APERÇU SEULEMENT — rien n’a été sauvegardé, émis ou envoyé.',
    openEditor: 'Ouvrir l’éditeur',
    disclaimer: 'L’IA prépare ou explique. Les calculs, validations, sauvegardes et autorisations restent contrôlés par Facturations.',
    customer: 'Client',
    total: 'Total',
    invoiceDate: 'Date',
    dueDate: 'Échéance',
    lines: 'Lignes',
    tax: 'Taxes',
  }),
  en: Object.freeze({
    title: 'Facturations Assistant',
    eyebrow: 'OpenAI · help and preparation',
    intro: 'Ask a question or prepare a draft. The assistant can never issue, send, publish, pay or change an invoice outside the normal Facturations workflow.',
    helpMode: 'Help',
    draftMode: 'Prepare a draft',
    placeholderHelp: 'Example: How do I create an invoice draft?',
    placeholderDraft: 'Example: Prepare a draft for Client ABC, cleaning service CA$850, no taxes, invoice dated September 27 2026, due October 12 2026, email client@example.com.',
    send: 'Send',
    back: 'Dashboard',
    language: 'Français',
    quick: 'Suggestions',
    help1: 'How do I create a draft?',
    help2: 'What is the difference between a draft and an issued invoice?',
    draft1: 'Prepare an invoice draft from my description.',
    working: 'Generating response…',
    blocked: 'The request was blocked by safety controls. Rephrase it without asking for a financial or irreversible action.',
    unavailable: 'The assistant is temporarily unavailable. Facturations continues to work normally without AI.',
    clarify: 'Missing information:',
    preview: 'Draft preview',
    previewOnly: 'PREVIEW ONLY — nothing was saved, issued or sent.',
    openEditor: 'Open editor',
    disclaimer: 'AI prepares or explains. Calculations, validation, saving and authorization remain controlled by Facturations.',
    customer: 'Customer',
    total: 'Total',
    invoiceDate: 'Date',
    dueDate: 'Due',
    lines: 'Lines',
    tax: 'Taxes',
  }),
});

function renderPage(language) {
  if (!Object.hasOwn(COPY, language)) throw new TypeError('Unsupported language');
  const t = COPY[language];
  const other = language === 'fr' ? 'en' : 'fr';
  const clientCopy = JSON.stringify({
    helpMode: t.helpMode,
    draftMode: t.draftMode,
    placeholderHelp: t.placeholderHelp,
    placeholderDraft: t.placeholderDraft,
    working: t.working,
    blocked: t.blocked,
    unavailable: t.unavailable,
    clarify: t.clarify,
    preview: t.preview,
    previewOnly: t.previewOnly,
    customer: t.customer,
    total: t.total,
    invoiceDate: t.invoiceDate,
    dueDate: t.dueDate,
    lines: t.lines,
    tax: t.tax,
  }).replace(/</g, '\\u003c');

  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f7;color:#122033}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,#f8fafc 0,#eef2f7 50%,#f8fafc 100%);line-height:1.5}
main{width:min(1060px,100%);margin:0 auto;padding:clamp(18px,4vw,44px)}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px;flex-wrap:wrap}
.brand{font-weight:900;letter-spacing:.09em;font-size:.78rem;color:#102b4f}.header-links{display:flex;gap:8px;flex-wrap:wrap}.header-links a{text-decoration:none;border:1px solid #ccd7e4;border-radius:10px;padding:9px 12px;background:#fff;color:#183b68;font-weight:750;font-size:.86rem}
.hero{margin-bottom:20px}.eyebrow{font-size:.76rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase;color:#5d7390}.hero h1{font-size:clamp(2rem,7vw,3.6rem);line-height:1.03;margin:7px 0 10px}.hero p{color:#607086;max-width:820px;margin:0}
.modebar{display:inline-flex;background:#e7edf5;border-radius:13px;padding:4px;margin-bottom:15px;gap:4px}.modebar button{border:0;background:transparent;color:#405670;border-radius:10px;padding:9px 13px;font:inherit;font-weight:800;cursor:pointer}.modebar button[aria-pressed="true"]{background:#102b4f;color:#fff}
.shell{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:18px}.chat,.quick{background:#fff;border:1px solid #dce4ee;border-radius:20px;box-shadow:0 18px 42px rgba(31,49,74,.06)}
.chat{overflow:hidden}.messages{min-height:380px;max-height:58vh;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:14px;background:linear-gradient(180deg,#fff 0,#fbfcfe 100%)}
.message{max-width:88%;padding:13px 15px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{align-self:flex-end;background:#102b4f;color:#fff;border-bottom-right-radius:5px}.message.assistant{align-self:flex-start;background:#edf3fa;color:#173451;border-bottom-left-radius:5px}.message.system{align-self:center;background:#fff5df;color:#694b0a;border:1px solid #f0dfb5;max-width:95%}
.preview-card{align-self:stretch;background:#f5f9ff;border:1px solid #cbdcf1;border-radius:16px;padding:16px}.preview-card h3{margin:0 0 5px}.preview-warning{font-size:.8rem;font-weight:900;color:#7b4b00;margin-bottom:12px}.preview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.preview-grid div{background:#fff;border:1px solid #dce7f2;border-radius:10px;padding:10px}.preview-grid span{display:block;font-size:.74rem;color:#728196;text-transform:uppercase;letter-spacing:.04em}.preview-grid strong{overflow-wrap:anywhere}
.composer{border-top:1px solid #e6ebf2;padding:16px;background:#fff}.composer label{font-weight:800;display:block;margin-bottom:8px}.row{display:flex;gap:10px;align-items:flex-end}.row textarea{flex:1;min-height:88px;max-height:210px;resize:vertical;border:1px solid #b8c6d8;border-radius:13px;padding:12px 13px;font:inherit;color:inherit}.row button{border:0;border-radius:12px;background:#102b4f;color:#fff;font:inherit;font-weight:850;padding:12px 17px;min-height:48px;cursor:pointer}.row button:disabled{opacity:.55;cursor:not-allowed}.status{min-height:24px;color:#64748b;font-size:.88rem;margin:8px 0 0}
.quick{padding:18px}.quick h2{font-size:1rem;margin:0 0 12px}.quick button,.editor-link{display:block;width:100%;text-align:left;border:1px solid #d7e0eb;background:#fbfcfe;color:#21405f;border-radius:12px;padding:12px;margin:9px 0;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}.quick button:hover,.editor-link:hover{background:#f1f6fb}.disclaimer{margin-top:14px;font-size:.82rem;color:#6b7889}
a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #4c75b9;outline-offset:3px}
@media(max-width:760px){.shell{grid-template-columns:1fr}.quick{order:-1}.messages{min-height:300px;max-height:48vh}.row{flex-direction:column;align-items:stretch}.row button{width:100%}.message{max-width:94%}.preview-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style><script src="/internal/assistant-client.js" defer></script></head><body><main>
<header><div class="brand">GROUPE TAKATAK · FACTURATIONS</div><nav class="header-links" aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.back}</a><a href="/internal/assistant?lang=${other}" lang="${other}">${t.language}</a></nav></header>
<section class="hero"><div class="eyebrow">${t.eyebrow}</div><h1>${t.title}</h1><p>${t.intro}</p></section>
<div class="modebar" aria-label="${t.title}"><button id="mode-help" type="button" aria-pressed="true">${t.helpMode}</button><button id="mode-draft" type="button" aria-pressed="false">${t.draftMode}</button></div>
<div class="shell"><section class="chat" aria-label="${t.title}"><div class="messages" id="messages" aria-live="polite"></div><form class="composer" id="assistant-form"><label id="composer-label" for="assistant-message">${t.helpMode}</label><div class="row"><textarea id="assistant-message" maxlength="4000" required placeholder="${t.placeholderHelp}"></textarea><button id="assistant-send" type="submit">${t.send}</button></div><p class="status" id="assistant-status" role="status"></p></form></section>
<aside class="quick"><h2>${t.quick}</h2><button type="button" data-mode="help" data-prompt="${t.help1}">${t.help1}</button><button type="button" data-mode="help" data-prompt="${t.help2}">${t.help2}</button><button type="button" data-mode="draft" data-prompt="${t.draft1}">${t.draft1}</button><a class="editor-link" href="/internal/editor?lang=${language}">${t.openEditor}</a><p class="disclaimer">${t.disclaimer}</p></aside></div>
<script type="application/json" id="assistant-copy">${clientCopy}</script>
</main></body></html>`;
}

const CLIENT = String.raw`'use strict';
(() => {
  const form = document.getElementById('assistant-form');
  const input = document.getElementById('assistant-message');
  const send = document.getElementById('assistant-send');
  const messages = document.getElementById('messages');
  const status = document.getElementById('assistant-status');
  const copyNode = document.getElementById('assistant-copy');
  const helpButton = document.getElementById('mode-help');
  const draftButton = document.getElementById('mode-draft');
  const label = document.getElementById('composer-label');
  if (!form || !input || !send || !messages || !status || !copyNode ||
      !helpButton || !draftButton || !label) return;

  let copy;
  try { copy = JSON.parse(copyNode.textContent); } catch { return; }
  const language = document.documentElement.lang === 'en' ? 'en' : 'fr';
  let csrf = null;
  let mode = 'help';

  function addMessage(kind, text) {
    const item = document.createElement('div');
    item.className = 'message ' + kind;
    item.textContent = text;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  }

  function money(cents) {
    if (!Number.isSafeInteger(cents)) return '—';
    return new Intl.NumberFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
      style: 'currency', currency: 'CAD',
    }).format(cents / 100);
  }

  function renderPreview(preview) {
    if (!preview || preview.status !== 'PREVIEW_ONLY') {
      addMessage('system', copy.blocked);
      return;
    }
    const card = document.createElement('section');
    card.className = 'preview-card';
    const heading = document.createElement('h3');
    heading.textContent = copy.preview;
    const warning = document.createElement('div');
    warning.className = 'preview-warning';
    warning.textContent = copy.previewOnly;
    const grid = document.createElement('div');
    grid.className = 'preview-grid';
    const values = [
      [copy.customer, preview.customer && preview.customer.name],
      [copy.total, money(preview.totalCents)],
      [copy.invoiceDate, preview.invoiceDate],
      [copy.dueDate, preview.dueDate],
      [copy.lines, Array.isArray(preview.lines) ? String(preview.lines.length) : '—'],
      [copy.tax, money(preview.taxTotalCents)],
    ];
    for (const [name, value] of values) {
      const cell = document.createElement('div');
      const caption = document.createElement('span');
      const strong = document.createElement('strong');
      caption.textContent = name;
      strong.textContent = value == null ? '—' : String(value);
      cell.append(caption, strong);
      grid.appendChild(cell);
    }
    card.append(heading, warning, grid);
    messages.appendChild(card);
    messages.scrollTop = messages.scrollHeight;
  }

  function setMode(next) {
    mode = next === 'draft' ? 'draft' : 'help';
    helpButton.setAttribute('aria-pressed', mode === 'help' ? 'true' : 'false');
    draftButton.setAttribute('aria-pressed', mode === 'draft' ? 'true' : 'false');
    label.textContent = mode === 'draft' ? copy.draftMode : copy.helpMode;
    input.placeholder = mode === 'draft' ? copy.placeholderDraft : copy.placeholderHelp;
    input.focus();
  }

  async function csrfToken() {
    if (csrf) return csrf;
    const response = await fetch('/internal/assistant/csrf', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('csrf');
    const body = await response.json();
    if (!body || typeof body.csrfToken !== 'string') throw new Error('csrf');
    csrf = body.csrfToken;
    return csrf;
  }

  async function ask(message) {
    send.disabled = true;
    input.disabled = true;
    status.textContent = copy.working;
    try {
      const token = await csrfToken();
      const draftMode = mode === 'draft';
      const response = await fetch(
        draftMode ? '/internal/assistant/propose-draft' : '/internal/assistant/help',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-Facturations-AI-CSRF': token,
            Accept: 'application/json',
          },
          body: JSON.stringify(draftMode
            ? { language, message, draftId: null }
            : { language, screenId: 'assistant', message }),
        },
      );
      if (response.status === 401 || response.status === 403) csrf = null;
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) throw new Error('unavailable');

      if (!draftMode) {
        if (body.answer) addMessage('assistant', body.answer);
        else addMessage('system', copy.blocked);
        return;
      }

      if (body.status === 'READY_FOR_PREVIEW' && body.preview) {
        renderPreview(body.preview);
      } else if (body.status === 'NEEDS_CLARIFICATION' &&
                 Array.isArray(body.clarifications) &&
                 body.clarifications.length) {
        addMessage('assistant', copy.clarify + '\n• ' + body.clarifications.join('\n• '));
      } else {
        addMessage('system', copy.blocked);
      }
    } catch {
      addMessage('system', copy.unavailable);
    } finally {
      status.textContent = '';
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  helpButton.addEventListener('click', () => setMode('help'));
  draftButton.addEventListener('click', () => setMode('draft'));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    addMessage('user', message);
    input.value = '';
    await ask(message);
  });

  for (const button of document.querySelectorAll('[data-prompt]')) {
    button.addEventListener('click', () => {
      setMode(button.getAttribute('data-mode'));
      input.value = button.getAttribute('data-prompt') || '';
      input.focus();
    });
  }
})();
`;

function send(response, status, type, body, csp) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    ...HEADERS,
    'Content-Type': type,
    'Content-Security-Policy': csp,
  });
  response.end(body);
}

function attachBrowserAiAssistantPage(server, { staffAuthStore } = {}) {
  if (!server || typeof server.listeners !== 'function' ||
      server.listeners('request').length !== 1 ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function') {
    throw new TypeError('Private AI assistant page requires staff authentication');
  }
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    const isPage = url.pathname === '/internal/assistant';
    const isScript = url.pathname === '/internal/assistant-client.js';
    if (!isPage && !isScript) return previous(request, response);
    if (request.method !== 'GET') {
      return send(response, 405, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    if (request.headers.authorization !== undefined ||
        request.headers['x-admin-key'] !== undefined) {
      return send(response, 401, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'UNAUTHORIZED' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) {
      return send(response, 401, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'UNAUTHORIZED' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    let staff;
    try { staff = await staffAuthStore.getSession(token); }
    catch {
      return send(response, 503, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'AUTH_UNAVAILABLE' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    if (!staff || !['OWNER', 'STAFF'].includes(staff.role)) {
      return send(response, 401, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'UNAUTHORIZED' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    if (isScript) {
      if (url.search || url.hash) {
        return send(response, 422, 'application/json; charset=utf-8',
          JSON.stringify({ error: 'INVALID_QUERY' }),
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      }
      return send(response, 200, 'text/javascript; charset=utf-8', CLIENT,
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    if ([...url.searchParams.keys()].some(key => key !== 'lang') ||
        url.searchParams.getAll('lang').length > 1) {
      return send(response, 422, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'INVALID_QUERY' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    const language = url.searchParams.get('lang') ?? 'fr';
    if (!Object.hasOwn(COPY, language)) {
      return send(response, 422, 'application/json; charset=utf-8',
        JSON.stringify({ error: 'INVALID_LANGUAGE' }),
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    return send(response, 200, 'text/html; charset=utf-8', renderPage(language),
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  });
  return server;
}

module.exports = { attachBrowserAiAssistantPage, renderPage, CLIENT };
