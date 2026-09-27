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
    eyebrow: 'Propulsé par OpenAI',
    intro: 'Posez une question sur Facturations. L’assistant peut expliquer et guider, mais il ne peut pas émettre, envoyer, payer ou modifier une facture à votre place.',
    placeholder: 'Ex. Comment créer un brouillon de facture?',
    send: 'Envoyer',
    back: 'Tableau de bord',
    language: 'English',
    quick: 'Questions rapides',
    prompt1: 'Comment créer un brouillon?',
    prompt2: 'Explique-moi la différence entre brouillon et facture émise.',
    prompt3: 'Comment retrouver un client?',
    you: 'Vous',
    assistant: 'Assistant',
    working: 'Réponse en cours…',
    blocked: 'Cette demande ne peut pas être traitée automatiquement. Reformulez-la comme une question d’aide ou d’explication.',
    unavailable: 'L’assistant est temporairement indisponible. Le reste de Facturations continue de fonctionner normalement.',
    disclaimer: 'Aucune action financière ou d’envoi n’est exécutée par cette conversation.',
  }),
  en: Object.freeze({
    title: 'Facturations Assistant',
    eyebrow: 'Powered by OpenAI',
    intro: 'Ask a question about Facturations. The assistant can explain and guide, but it cannot issue, send, pay or change an invoice on your behalf.',
    placeholder: 'Example: How do I create an invoice draft?',
    send: 'Send',
    back: 'Dashboard',
    language: 'Français',
    quick: 'Quick questions',
    prompt1: 'How do I create a draft?',
    prompt2: 'Explain the difference between a draft and an issued invoice.',
    prompt3: 'How do I find a customer?',
    you: 'You',
    assistant: 'Assistant',
    working: 'Generating answer…',
    blocked: 'This request cannot be handled automatically. Rephrase it as a help or explanation question.',
    unavailable: 'The assistant is temporarily unavailable. The rest of Facturations continues to work normally.',
    disclaimer: 'No financial or delivery action is executed by this conversation.',
  }),
});

function renderPage(language) {
  if (!Object.hasOwn(COPY, language)) throw new TypeError('Unsupported language');
  const t = COPY[language];
  const other = language === 'fr' ? 'en' : 'fr';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f7;color:#122033}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,#f8fafc 0,#eef2f7 50%,#f8fafc 100%);line-height:1.5}
main{width:min(980px,100%);margin:0 auto;padding:clamp(18px,4vw,44px)}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px;flex-wrap:wrap}
.brand{font-weight:900;letter-spacing:.09em;font-size:.78rem;color:#102b4f}.header-links{display:flex;gap:8px;flex-wrap:wrap}.header-links a{text-decoration:none;border:1px solid #ccd7e4;border-radius:10px;padding:9px 12px;background:#fff;color:#183b68;font-weight:750;font-size:.86rem}
.hero{margin-bottom:20px}.eyebrow{font-size:.76rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase;color:#5d7390}.hero h1{font-size:clamp(2rem,7vw,3.6rem);line-height:1.03;margin:7px 0 10px}.hero p{color:#607086;max-width:760px;margin:0}
.shell{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:18px}.chat,.quick{background:#fff;border:1px solid #dce4ee;border-radius:20px;box-shadow:0 18px 42px rgba(31,49,74,.06)}
.chat{overflow:hidden}.messages{min-height:360px;max-height:58vh;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:14px;background:linear-gradient(180deg,#fff 0,#fbfcfe 100%)}
.message{max-width:84%;padding:13px 15px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{align-self:flex-end;background:#102b4f;color:#fff;border-bottom-right-radius:5px}.message.assistant{align-self:flex-start;background:#edf3fa;color:#173451;border-bottom-left-radius:5px}.message.system{align-self:center;background:#fff5df;color:#694b0a;border:1px solid #f0dfb5;max-width:94%}
.composer{border-top:1px solid #e6ebf2;padding:16px;background:#fff}.composer label{font-weight:800;display:block;margin-bottom:8px}.row{display:flex;gap:10px;align-items:flex-end}.row textarea{flex:1;min-height:78px;max-height:180px;resize:vertical;border:1px solid #b8c6d8;border-radius:13px;padding:12px 13px;font:inherit;color:inherit}.row button{border:0;border-radius:12px;background:#102b4f;color:#fff;font:inherit;font-weight:850;padding:12px 17px;min-height:48px;cursor:pointer}.row button:disabled{opacity:.55;cursor:not-allowed}.status{min-height:24px;color:#64748b;font-size:.88rem;margin:8px 0 0}
.quick{padding:18px}.quick h2{font-size:1rem;margin:0 0 12px}.quick button{display:block;width:100%;text-align:left;border:1px solid #d7e0eb;background:#fbfcfe;color:#21405f;border-radius:12px;padding:12px;margin:9px 0;font:inherit;font-weight:700;cursor:pointer}.quick button:hover{background:#f1f6fb}.disclaimer{margin-top:14px;font-size:.82rem;color:#6b7889}
a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid #4c75b9;outline-offset:3px}
@media(max-width:760px){.shell{grid-template-columns:1fr}.quick{order:-1}.messages{min-height:300px;max-height:48vh}.row{flex-direction:column;align-items:stretch}.row button{width:100%}.message{max-width:92%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style><script src="/internal/assistant-client.js" defer></script></head><body><main>
<header><div class="brand">GROUPE TAKATAK · FACTURATIONS</div><nav class="header-links" aria-label="Navigation"><a href="/internal/dashboard?lang=${language}">${t.back}</a><a href="/internal/assistant?lang=${other}" lang="${other}">${t.language}</a></nav></header>
<section class="hero"><div class="eyebrow">${t.eyebrow}</div><h1>${t.title}</h1><p>${t.intro}</p></section>
<div class="shell"><section class="chat" aria-label="${t.title}"><div class="messages" id="messages" aria-live="polite"></div><form class="composer" id="assistant-form"><label for="assistant-message">${t.title}</label><div class="row"><textarea id="assistant-message" maxlength="4000" required placeholder="${t.placeholder}"></textarea><button id="assistant-send" type="submit">${t.send}</button></div><p class="status" id="assistant-status" role="status"></p></form></section>
<aside class="quick"><h2>${t.quick}</h2><button type="button" data-prompt="${t.prompt1}">${t.prompt1}</button><button type="button" data-prompt="${t.prompt2}">${t.prompt2}</button><button type="button" data-prompt="${t.prompt3}">${t.prompt3}</button><p class="disclaimer">${t.disclaimer}</p></aside></div>
<script type="application/json" id="assistant-copy">${JSON.stringify({
    you: t.you, assistant: t.assistant, working: t.working,
    blocked: t.blocked, unavailable: t.unavailable,
  }).replace(/</g, '\\u003c')}</script>
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
  if (!form || !input || !send || !messages || !status || !copyNode) return;

  let copy;
  try { copy = JSON.parse(copyNode.textContent); }
  catch { return; }
  const language = document.documentElement.lang === 'en' ? 'en' : 'fr';
  let csrf = null;

  function addMessage(kind, text) {
    const item = document.createElement('div');
    item.className = 'message ' + kind;
    item.textContent = text;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
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
      const response = await fetch('/internal/assistant/help', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Facturations-AI-CSRF': token,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          language,
          screenId: 'assistant',
          message,
        }),
      });
      if (response.status === 401 || response.status === 403) csrf = null;
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) throw new Error('unavailable');
      if (body.answer) addMessage('assistant', body.answer);
      else addMessage('system', copy.blocked);
    } catch {
      addMessage('system', copy.unavailable);
    } finally {
      status.textContent = '';
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

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
