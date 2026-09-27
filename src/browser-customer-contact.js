'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readStaffSessionCookie } = require('./staff-session-cookie');
const { CustomerContactError } = require('./customer-contact-store');
const { escapeHtml } = require('./dashboard-view');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CSRF = /^[A-Za-z0-9_-]{43}$/;
const FORM_FIELDS = ['csrf', 'intent', 'revision', 'name', 'email', 'address'];
const MAX_BODY = 4096;
const COPY = Object.freeze({
  fr: Object.freeze({ title: 'Fiche client', newTitle: 'Ajouter un client', editTitle: 'Corriger une fiche client',
    name: 'Nom du client', email: 'Courriel', address: 'Adresse', revision: 'Révision',
    save: 'Enregistrer la fiche seulement', back: 'Répertoire clients', other: 'en', language: 'English',
    note: 'Cette action modifie uniquement le répertoire privé. Les brouillons immuables déjà préparés ne sont pas modifiés. Aucune facture, aucun courriel et aucun paiement.',
    required: 'Le nom et le courriel sont requis. Vérifiez les coordonnées avant toute émission.' }),
  en: Object.freeze({ title: 'Customer record', newTitle: 'Add a customer', editTitle: 'Correct customer details',
    name: 'Customer name', email: 'Email', address: 'Address', revision: 'Revision',
    save: 'Save contact only', back: 'Customer directory', other: 'fr', language: 'Français',
    note: 'This changes only the private directory. Existing immutable drafts are not changed. No invoice, email or payment.',
    required: 'Name and email are required. Verify contact information before any issuance.' }),
});
const HEADERS = Object.freeze({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
function reply(response, status, type, body, extra = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, ...extra, 'Content-Type': type }); response.end(body);
}
function deny(response, status) { reply(response, status, 'text/plain; charset=utf-8', 'Customer contact unavailable'); }
function csrfFor(key, token, id) {
  return crypto.createHmac('sha256', key).update('facturations-customer-contact-v1:')
    .update(token).update(':').update(id || 'new').digest('base64url');
}
function renderContactForm(contact, lang, csrf) {
  if (!Object.hasOwn(COPY, lang) || !CSRF.test(csrf || '') ||
      (contact !== null && (!UUID.test(contact?.id || '') || !Number.isSafeInteger(contact.revision)))) {
    throw new TypeError('Private customer form data required');
  }
  const t = COPY[lang];
  const id = contact?.id || null;
  const action = `/internal/customer-contact?lang=${lang}${id ? `&amp;id=${id}` : ''}`;
  const languageLink = `/internal/customer-contact?lang=${t.other}${id ? `&amp;id=${id}` : ''}`;
  const title = id ? t.editTitle : t.newTitle;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f6fa;color:#17253c}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:760px;margin:auto;padding:clamp(18px,4vw,48px)}header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:15px}.brand{font-weight:800;letter-spacing:.08em;color:#14536b}nav{display:flex;gap:18px}a{color:#194a91;font-weight:700}a:focus-visible,input:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid #3567b7;outline-offset:3px}h1{font-size:clamp(1.9rem,5vw,2.8rem)}.panel{background:white;border:1px solid #dce5ef;border-radius:16px;padding:clamp(18px,4vw,32px);margin:22px 0}.notice{border-left:4px solid #3567b7;background:#eaf1ff;padding:14px;border-radius:8px}label{display:block;font-weight:700;margin-top:18px}input,textarea{display:block;font:inherit;width:100%;margin-top:6px;padding:12px;border:1px solid #b3c2d6;border-radius:8px}textarea{min-height:100px;resize:vertical}button{font:inherit;font-weight:700;margin-top:22px;padding:13px 18px;border:0;border-radius:9px;background:#164b9b;color:white;cursor:pointer}.muted{color:#52647c}</style></head><body><main>
<header><div class="brand">GROUPE TAKATAK</div><nav><a href="/internal/customers?lang=${lang}">${t.back}</a><a href="${languageLink}" lang="${t.other}">${t.language}</a></nav></header><h1>${title}</h1><p class="notice" role="note">${t.note}</p><p class="muted">${t.required}</p>
<section class="panel"><form method="post" action="${action}" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="intent" value="SAVE_CONTACT_ONLY"><input type="hidden" name="revision" value="${contact?.revision || ''}">
<label for="name">${t.name}<input id="name" name="name" type="text" maxlength="160" required value="${escapeHtml(contact?.name || '')}"></label><label for="email">${t.email}<input id="email" name="email" type="email" maxlength="254" required value="${escapeHtml(contact?.email || '')}"></label><label for="address">${t.address}<textarea id="address" name="address" maxlength="1000">${escapeHtml(contact?.address || '')}</textarea></label>${id ? `<p class="muted">${t.revision}: ${contact.revision}</p>` : ''}<button type="submit">${t.save}</button></form></section></main></body></html>`;
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin && request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function readForm(request) {
  return new Promise((resolve, reject) => {
    let done = false, size = 0; const chunks = [];
    const fail = status => { if (done) return; done = true; request.resume(); reject(status); };
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) return fail(413);
    request.on('data', chunk => { if (done) return; size += chunk.length;
      if (size > MAX_BODY) return fail(413); chunks.push(chunk); });
    request.on('aborted', () => fail(400)); request.on('error', () => fail(400));
    request.on('end', () => { if (done) return; done = true;
      try {
        const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if ([...form.keys()].length !== FORM_FIELDS.length ||
            FORM_FIELDS.some(field => form.getAll(field).length !== 1) ||
            [...form.keys()].some(field => !FORM_FIELDS.includes(field))) return reject(422);
        resolve(form);
      } catch { reject(422); }
    });
  });
}
function attachBrowserCustomerContact(server, { origin, businessId, encryptionKeyHex, staffAuthStore, contactStore }) {
  let validOrigin = false;
  try { validOrigin = typeof origin === 'string' && origin.startsWith('https://') && new URL(origin).origin === origin; }
  catch { /* Fail closed. */ }
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      !validOrigin || !businessId || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex || '') ||
      !staffAuthStore || typeof staffAuthStore.getSession !== 'function' ||
      !contactStore || typeof contactStore.getContact !== 'function' || typeof contactStore.saveContact !== 'function') {
    throw new TypeError('Dedicated owner customer contact dependencies required');
  }
  const key = crypto.createHmac('sha256', Buffer.from(encryptionKeyHex, 'hex'))
    .update('facturations-customer-contact-csrf-key-v1').digest();
  const previous = server.listeners('request')[0];
  server.removeListener('request', previous);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return previous(request, response); }
    if (url.pathname !== '/internal/customer-contact') return previous(request, response);
    if (!['GET', 'POST'].includes(request.method)) return deny(response, 405);
    if (url.hash || [...url.searchParams.keys()].some(field =>
      !['lang', 'id'].includes(field) || url.searchParams.getAll(field).length !== 1)) return deny(response, 422);
    const lang = url.searchParams.get('lang') ?? 'fr';
    const id = url.searchParams.get('id');
    if (!Object.hasOwn(COPY, lang) || (id !== null && !UUID.test(id))) return deny(response, 422);
    if (request.headers.authorization !== undefined || request.headers['x-admin-key'] !== undefined) return deny(response, 401);
    const token = readStaffSessionCookie(request.headers.cookie);
    if (!token) return deny(response, 401);
    if (request.method === 'POST') {
      if (!sameOrigin(request, origin)) return deny(response, 403);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return deny(response, 415);
    }
    try {
      const staff = await staffAuthStore.getSession(token);
      if (!staff || staff.businessId !== businessId) return deny(response, 401);
      if (staff.role !== 'OWNER') return deny(response, 403);
      if (request.method === 'GET') {
        const contact = id === null ? null : await contactStore.getContact(id);
        return reply(response, 200, 'text/html; charset=utf-8', renderContactForm(contact, lang, csrfFor(key, token, id)));
      }
      const form = await readForm(request);
      const supplied = form.get('csrf'), expected = csrfFor(key, token, id);
      if (!CSRF.test(supplied || '') || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return deny(response, 403);
      if (form.get('intent') !== 'SAVE_CONTACT_ONLY') return deny(response, 422);
      const rawRevision = form.get('revision');
      if ((id === null && rawRevision !== '') ||
          (id !== null && !/^[1-9][0-9]{0,9}$/.test(rawRevision || ''))) return deny(response, 422);
      const result = await contactStore.saveContact({ sessionToken: token, ownerId: staff.id, id,
        expectedRevision: id === null ? null : Number(rawRevision),
        name: form.get('name'), email: form.get('email'), address: form.get('address') });
      // Post/Redirect/Get: a refresh cannot accidentally resubmit the contact form.
      return reply(response, 303, 'text/plain; charset=utf-8', '',
        { Location: `/internal/customer-contact?lang=${lang}&id=${result.id}` });
    } catch (error) {
      if (error instanceof CustomerContactError && [403, 404, 409, 422].includes(error.statusCode)) return deny(response, error.statusCode);
      if ([400, 413, 422].includes(error)) return deny(response, error);
      return deny(response, 503);
    }
  });
  return server;
}
module.exports = { attachBrowserCustomerContact, renderContactForm, csrfFor };
