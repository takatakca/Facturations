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
const FIELDS = ['csrf','confirmation','expectedTotalCents','expectedCustomerEmail','provider',
  'recipientReviewed','amountReviewed','datesReviewed','taxesReviewed','providerReviewed'];

const COPY = Object.freeze({
  fr: Object.freeze({
    title: 'Autoriser la préparation de l’émission',
    back: 'Retour à la révision',
    other: 'en',
    language: 'English',
    notice: 'Cette étape enregistre uniquement votre autorisation de passer à la phase d’émission. Elle ne crée aucun numéro de facture, ne contacte pas Wave, ne génère aucun PDF officiel, n’envoie aucun courriel et ne prend aucun paiement.',
    customer: 'Destinataire',
    dates: 'Dates',
    total: 'Total calculé',
    provider: 'Fournisseur prévu',
    providerValue: 'Wave — non appelé à cette étape',
    authorize: 'Autoriser l’émission en attente du fournisseur',
    authorized: 'Autorisation enregistrée. La facture demeure non émise et en attente du fournisseur.',
    checks: [
      'J’ai revérifié le nom et le courriel du destinataire.',
      'J’ai revérifié les articles, rabais et le total.',
      'J’ai revérifié la date de facture et la date d’échéance.',
      'J’ai revérifié les taxes indiquées et leur applicabilité.',
      'Je comprends que cette autorisation ne déclenche aucun appel Wave ni envoi client.'
    ],
  }),
  en: Object.freeze({
    title: 'Authorize issuance preparation',
    back: 'Back to review',
    other: 'fr',
    language: 'Français',
    notice: 'This step only records your authorization to proceed toward issuance. It does not create an invoice number, contact Wave, generate an official PDF, send email, or take payment.',
    customer: 'Recipient',
    dates: 'Dates',
    total: 'Calculated total',
    provider: 'Planned provider',
    providerValue: 'Wave — not called at this step',
    authorize: 'Authorize issuance pending provider',
    authorized: 'Authorization recorded. The invoice remains unissued and pending provider.',
    checks: [
      'I rechecked the recipient name and email.',
      'I rechecked the items, discounts and total.',
      'I rechecked the invoice date and due date.',
      'I rechecked the stated taxes and applicability.',
      'I understand this authorization does not trigger any Wave call or customer delivery.'
    ],
  }),
});

const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
});

function reply(response, status, type, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}
function deny(response, status) {
  reply(response, status, 'text/plain; charset=utf-8', 'Issuance authorization unavailable');
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
      !p || p.status !== 'DRAFT' || p.persisted !== true || p.currency !== 'CAD' ||
      !Number.isSafeInteger(p.totalCents) || p.totalCents < 0 ||
      typeof p.customer?.email !== 'string') {
    throw new TypeError('Approved immutable draft required');
  }
  return p;
}
function page(row, lang, csrf, authorization = null) {
  if (!Object.hasOwn(COPY, lang)) throw new TypeError('Unsupported language');
  const p = snapshotOf(row);
  const t = COPY[lang];
  const id = row.id.toLowerCase();
  const amount = escapeHtml(money(p.totalCents, lang));
  const decision = authorization
    ? `<section class="panel" role="status"><strong>${t.authorized}</strong><p><strong>${escapeHtml(authorization.status)}</strong></p></section>`
    : `<section class="panel"><form method="post" action="/internal/review/${id}/authorize-issuance?lang=${lang}" autocomplete="off">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="confirmation" value="AUTHORIZE_ISSUANCE_PENDING_PROVIDER">
<input type="hidden" name="expectedTotalCents" value="${p.totalCents}">
<input type="hidden" name="expectedCustomerEmail" value="${escapeHtml(p.customer.email)}">
<input type="hidden" name="provider" value="WAVE">
<div class="checks">${['recipientReviewed','amountReviewed','datesReviewed','taxesReviewed','providerReviewed']
  .map((name,index)=>`<label><input type="checkbox" name="${name}" value="yes" required>${t.checks[index]}</label>`).join('')}</div>
<button type="submit">${t.authorize}</button></form></section>`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title} — GROUPE TAKATAK</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17253c;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:820px;margin:auto;padding:clamp(16px,4vw,44px)}.brand{font-weight:800;letter-spacing:.08em;color:#14536b}.panel{background:#fff;border:1px solid #dce5ef;border-radius:15px;padding:clamp(16px,4vw,28px);margin:20px 0}.notice{border-left:4px solid #8a5a16;background:#fff4df;padding:14px;border-radius:7px}.checks label{display:flex;gap:12px;align-items:flex-start;margin:14px 0}.checks input{width:21px;height:21px;flex-shrink:0}button{font:inherit;font-weight:800;border:0;border-radius:9px;background:#164b9b;color:#fff;padding:13px 18px;cursor:pointer}a{color:#174b95;font-weight:700}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #3567b7;outline-offset:3px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:620px){.meta{grid-template-columns:1fr}}
</style></head><body><main><div class="brand">GROUPE TAKATAK</div>
<p><a href="/internal/review/${id}?lang=${lang}">${t.back}</a> · <a href="/internal/review/${id}/authorize-issuance?lang=${t.other}" lang="${t.other}">${t.language}</a></p>
<h1>${t.title}</h1><p class="notice" role="note">${t.notice}</p>
<section class="panel"><div class="meta"><div><h2>${t.customer}</h2><p>${escapeHtml(p.customer.name)}<br>${escapeHtml(p.customer.email)}</p></div><div><h2>${t.dates}</h2><p>${escapeHtml(p.invoiceDate)}<br>${escapeHtml(p.dueDate)}</p></div></div>
<h2>${t.total}</h2><p><strong>${amount}</strong></p><h2>${t.provider}</h2><p>${t.providerValue}</p></section>
${decision}</main></body></html>`;
}
function sameOrigin(request, origin) {
  return request.headers.origin === origin &&
    request.headers.host === new URL(origin).host &&
    (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
function readBody(request) {
  return new Promise((resolve,reject)=>{
    let done=false,size=0; const chunks=[];
    const fail=status=>{ if(done)return; done=true; request.resume(); reject(status); };
    const declared=request.headers['content-length'];
    if(declared!==undefined && (!/^\d+$/.test(declared)||Number(declared)>3072)) return fail(413);
    request.on('data',chunk=>{ if(done)return; size+=chunk.length; if(size>3072)return fail(413); chunks.push(chunk); });
    request.on('aborted',()=>fail(400));
    request.on('error',()=>fail(400));
    request.on('end',()=>{
      if(done)return; done=true;
      try{
        const form=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
        if([...form.keys()].length!==FIELDS.length ||
           FIELDS.some(field=>form.getAll(field).length!==1) ||
           [...form.keys()].some(field=>!FIELDS.includes(field))) return reject(422);
        resolve(form);
      }catch{ reject(422); }
    });
  });
}

function attachBrowserIssuanceAuthorization(server, {
  origin, businessId, encryptionKeyHex, staffAuthStore, draftStore, approvalStore, authorizationStore,
}) {
  let validOrigin=false;
  try { validOrigin=typeof origin==='string' && origin.startsWith('https://') && new URL(origin).origin===origin; }
  catch { /* fail closed */ }
  if (!server || typeof server.listeners!=='function' || server.listeners('request').length!==1 ||
      !validOrigin || !businessId || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex || '') ||
      !staffAuthStore || typeof staffAuthStore.getSession!=='function' ||
      !draftStore || typeof draftStore.getDraft!=='function' ||
      !approvalStore || typeof approvalStore.isApproved!=='function' ||
      !authorizationStore || typeof authorizationStore.authorize!=='function' ||
      typeof authorizationStore.getAuthorization!=='function') {
    throw new TypeError('Dedicated owner issuance authorization dependencies required');
  }
  const key=crypto.createHmac('sha256',Buffer.from(encryptionKeyHex,'hex'))
    .update('facturations-browser-issuance-authorization-key-v1').digest();
  const previous=server.listeners('request')[0];
  server.removeListener('request',previous);
  server.on('request',async(request,response)=>{
    let url;
    try { url=new URL(request.url,'http://localhost'); } catch { return previous(request,response); }
    const match=PATH.exec(url.pathname);
    if(!match) return previous(request,response);
    if(!['GET','POST'].includes(request.method)) return deny(response,405);
    if(!UUID.test(match[1]) || url.hash ||
       [...url.searchParams.keys()].some(k=>k!=='lang'||url.searchParams.getAll(k).length!==1)) return deny(response,422);
    const lang=url.searchParams.get('lang') ?? 'fr';
    if(!Object.hasOwn(COPY,lang)) return deny(response,422);
    if(request.headers.authorization!==undefined || request.headers['x-admin-key']!==undefined) return deny(response,401);
    const token=readStaffSessionCookie(request.headers.cookie);
    if(!token) return deny(response,401);
    if(request.method==='POST'){
      if(!sameOrigin(request,origin)) return deny(response,403);
      if(!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']||'')) return deny(response,415);
    }
    try{
      const staff=await staffAuthStore.getSession(token);
      if(!staff || staff.businessId!==businessId) return deny(response,401);
      if(staff.role!=='OWNER') return deny(response,403);
      const approved=await approvalStore.isApproved({draftId:match[1],ownerId:staff.id,sessionToken:token});
      if(!approved) return deny(response,409);
      const row=await draftStore.getDraft(match[1]);
      if(request.method==='GET'){
        const existing=await authorizationStore.getAuthorization({
          draftId:row.id,ownerId:staff.id,sessionToken:token,
        });
        return reply(response,200,'text/html; charset=utf-8',
          page(row,lang,existing ? '' : csrfFor(key,token,row.id),existing));
      }
      const body=await readBody(request);
      const supplied=body.get('csrf');
      const expected=csrfFor(key,token,row.id);
      if(typeof supplied!=='string' || !CSRF.test(supplied) ||
         !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) return deny(response,403);
      if(body.get('confirmation')!=='AUTHORIZE_ISSUANCE_PENDING_PROVIDER' ||
         body.get('provider')!=='WAVE' ||
         FIELDS.slice(5).some(field=>body.get(field)!=='yes')) return deny(response,422);
      const rawTotal=body.get('expectedTotalCents');
      if(!/^(0|[1-9][0-9]{0,12})$/.test(rawTotal||'')) return deny(response,422);
      const result=await authorizationStore.authorize({
        confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
        draftId:row.id,
        ownerId:staff.id,
        sessionToken:token,
        expectedTotalCents:Number(rawTotal),
        expectedCustomerEmail:body.get('expectedCustomerEmail'),
        provider:'WAVE',
      });
      return reply(response,200,'text/html; charset=utf-8',page(row,lang,'',result));
    }catch(error){
      if(error instanceof IssuanceAuthorizationError ||
         error instanceof DraftApprovalError ||
         error instanceof StoreError){
        if([401,403,404,409,422].includes(error.statusCode)) return deny(response,error.statusCode);
      }
      if([400,413,422].includes(error)) return deny(response,error);
      return deny(response,503);
    }
  });
  return server;
}

module.exports = { attachBrowserIssuanceAuthorization, renderIssuanceAuthorization: page, issuanceCsrfFor: csrfFor };
