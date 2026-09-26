'use strict';

const { TextDecoder } = require('node:util');
const {
  createClientSessionCookie,
  clearClientSessionCookie,
  readClientSessionCookie,
} = require('./client-session-cookie');

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const INVOICE_PATH=new RegExp('^/portal/invoices/('+UUID+')$','i');
const PDF_PATH=new RegExp('^/portal/documents/('+UUID+')\\.pdf$','i');
const MAX_FORM_BYTES=1024;

const HEADERS=Object.freeze({
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'",
});

const COPY=Object.freeze({
  fr:Object.freeze({
    portal:'Portail client', welcome:'Vos factures', subtitle:'Accès sécurisé · GROUPE TAKATAK',
    accessTitle:'Ouvrir votre portail', accessText:'Confirmez pour utiliser ce lien sécurisé à usage unique.',
    continue:'Continuer vers mes factures', signedOut:'Accès sécurisé requis',
    signedOutText:'Utilisez le lien privé reçu pour accéder à vos factures. Aucun numéro de facture ne permet de contourner la connexion.',
    invoices:'Factures publiées', empty:'Aucune facture publiée pour le moment.',
    number:'Facture', date:'Date', due:'Échéance', total:'Total', balance:'Solde',
    state:'État financier', proof:'Portée de preuve', details:'Voir les détails',
    paid:'Payé', refunded:'Remboursé', net:'Net payé', published:'Publiée',
    pdf:'Voir le PDF officiel', back:'Retour aux factures', logout:'Se déconnecter',
    proofSynthetic:'Les données financières affichées proviennent uniquement de preuves de test synthétiques.',
    proofNone:'Aucune preuve financière externe n’est enregistrée.',
    proofVerified:'Une preuve fournisseur vérifiée est présente dans le ledger.',
    sessionError:'Votre session est expirée ou invalide. Utilisez un nouveau lien sécurisé.',
    accessError:'Ce lien est invalide, expiré ou déjà utilisé.',
    financial:Object.freeze({
      NO_EVIDENCE:'Aucune preuve',UNPAID:'Non payée',PARTIALLY_PAID:'Partiellement payée',
      PAID:'Payée',OVERPAID:'Surpayée',FULLY_REFUNDED:'Entièrement remboursée',
      REFUND_EXCEEDS_PAYMENTS:'Remboursement supérieur aux paiements',
    }),
  }),
  en:Object.freeze({
    portal:'Client portal', welcome:'Your invoices', subtitle:'Secure access · GROUPE TAKATAK',
    accessTitle:'Open your portal', accessText:'Confirm to use this secure one-time link.',
    continue:'Continue to my invoices', signedOut:'Secure access required',
    signedOutText:'Use the private link you received to access your invoices. An invoice number alone never bypasses sign-in.',
    invoices:'Published invoices', empty:'No published invoices yet.',
    number:'Invoice', date:'Date', due:'Due', total:'Total', balance:'Balance',
    state:'Financial status', proof:'Evidence scope', details:'View details',
    paid:'Paid', refunded:'Refunded', net:'Net paid', published:'Published',
    pdf:'View official PDF', back:'Back to invoices', logout:'Sign out',
    proofSynthetic:'Financial data shown here comes only from synthetic test evidence.',
    proofNone:'No external financial evidence is recorded.',
    proofVerified:'Verified provider evidence is present in the ledger.',
    sessionError:'Your session expired or is invalid. Use a new secure link.',
    accessError:'This link is invalid, expired, or already used.',
    financial:Object.freeze({
      NO_EVIDENCE:'No evidence',UNPAID:'Unpaid',PARTIALLY_PAID:'Partially paid',
      PAID:'Paid',OVERPAID:'Overpaid',FULLY_REFUNDED:'Fully refunded',
      REFUND_EXCEEDS_PAYMENTS:'Refund exceeds payments',
    }),
  }),
});

function escapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[char]);
}
function money(cents,language){
  if(!Number.isSafeInteger(cents)) return '—';
  const negative=cents<0;
  const absolute=BigInt(Math.abs(cents));
  const whole=(absolute/100n).toString();
  const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,language==='fr'?'\u202f':',');
  const fraction=(absolute%100n).toString().padStart(2,'0');
  const amount=language==='fr'?grouped+','+fraction+'\u00a0$ CA':'CA$'+grouped+'.'+fraction;
  return negative?'−'+amount:amount;
}
function languageOf(url){
  if([...url.searchParams.keys()].some(key=>key!=='lang') || url.searchParams.getAll('lang').length>1) return null;
  const language=url.searchParams.get('lang')??'fr';
  return Object.hasOwn(COPY,language)?language:null;
}
function languageWithToken(url){
  if([...url.searchParams.keys()].some(key=>!['lang','token'].includes(key)) ||
     url.searchParams.getAll('lang').length>1 || url.searchParams.getAll('token').length!==1) return null;
  const language=url.searchParams.get('lang')??'fr';
  const token=url.searchParams.get('token');
  return Object.hasOwn(COPY,language) && TOKEN.test(token)?{language,token}:null;
}
function sameOrigin(request,origin){
  const host=new URL(origin).host;
  return request.headers.origin===origin && request.headers.host===host &&
    (request.headers['sec-fetch-site']===undefined || request.headers['sec-fetch-site']==='same-origin') &&
    request.headers.authorization===undefined && request.headers['x-admin-key']===undefined;
}
function safeGet(request,origin){
  return request.headers.host===new URL(origin).host &&
    request.headers.authorization===undefined && request.headers['x-admin-key']===undefined;
}
function reply(response,status,extra={},body=''){
  if(response.headersSent || response.destroyed) return;
  response.writeHead(status,{...HEADERS,...extra});
  response.end(body);
}
function page(language,title,body){
  const t=COPY[language];
  const other=language==='fr'?'en':'fr';
  const otherLabel=language==='fr'?'English':'Français';
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — GROUPE TAKATAK</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f6fa;color:#152338}*{box-sizing:border-box}body{margin:0;line-height:1.5}main{max-width:980px;margin:auto;padding:clamp(18px,4vw,52px)}header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:30px}.brand{font-size:.78rem;font-weight:850;letter-spacing:.12em;color:#14536b}.lang{font-weight:750;color:#164b9b;text-decoration:none}.lang:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid #3567b7;outline-offset:3px}h1{font-size:clamp(2rem,6vw,3.1rem);line-height:1.08;margin:.35rem 0}.muted{color:#52647c}.panel,.card{background:#fff;border:1px solid #dce5ef;border-radius:18px;box-shadow:0 4px 18px rgba(12,28,48,.04)}.panel{padding:clamp(20px,4vw,38px)}.cards{display:grid;gap:14px}.card{padding:20px}.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:14px}.number{font-weight:850;font-size:1.1rem}.money{font-weight:850;font-variant-numeric:tabular-nums}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:22px 0}.metric{padding:16px;border-radius:12px;background:#f6f8fb}.metric span{display:block;color:#52647c;font-size:.84rem}.metric strong{display:block;margin-top:4px;overflow-wrap:anywhere}.button,button{display:inline-block;border:0;border-radius:10px;padding:12px 16px;background:#164b9b;color:#fff;font:inherit;font-weight:800;text-decoration:none;cursor:pointer}.secondary{background:#fff;color:#173e76;border:1px solid #b7c8df}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:18px}.actions form{margin:0}.notice{border-left:4px solid #3567b7;background:#eaf1ff;color:#234576;padding:13px 15px;border-radius:8px;margin:16px 0}.danger{border-left-color:#9a3030;background:#fff1f1;color:#862626}.empty{text-align:center;color:#52647c;padding:38px 12px}.hash{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem;overflow-wrap:anywhere}.status{display:inline-block;border-radius:999px;background:#e5f5ed;color:#0e5d38;padding:4px 10px;font-weight:750;font-size:.82rem}footer{margin-top:30px;color:#64748b;font-size:.8rem}@media(max-width:650px){header{align-items:flex-start}.grid{grid-template-columns:1fr}.row{display:block}.row .money{margin-top:8px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important}}
</style></head><body><main><header><div><div class="brand">GROUPE TAKATAK</div><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(t.subtitle)}</p></div><a class="lang" href="/portal?lang=${other}" lang="${other}">${otherLabel}</a></header>${body}<footer>${escapeHtml(t.portal)} · GROUPE TAKATAK</footer></main></body></html>`;
}
function renderAccess(language,token,error=false){
  const t=COPY[language];
  const notice=error?`<p class="notice danger" role="alert">${escapeHtml(t.accessError)}</p>`:'';
  return page(language,t.accessTitle,`<section class="panel">${notice}<p>${escapeHtml(t.accessText)}</p><form method="post" action="/portal/access?lang=${language}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${escapeHtml(t.continue)}</button></form></section>`);
}
function renderSignedOut(language){
  const t=COPY[language];
  return page(language,t.signedOut,`<section class="panel"><p class="notice danger" role="alert">${escapeHtml(t.sessionError)}</p><p>${escapeHtml(t.signedOutText)}</p></section>`);
}
function proofNotice(payment,language){
  const t=COPY[language];
  if(payment.proofScope==='VERIFIED_PROVIDER_PRESENT' && payment.externallyVerified) return t.proofVerified;
  if(payment.proofScope==='SYNTHETIC_ONLY') return t.proofSynthetic;
  return t.proofNone;
}
function statusLabel(payment,language){
  return COPY[language].financial[payment.financialState]??payment.financialState;
}
function renderList(invoices,language){
  const t=COPY[language];
  const cards=invoices.map(item=>`<article class="card"><div class="row"><div><div class="number">${escapeHtml(t.number)} ${escapeHtml(item.officialInvoiceNumber)}</div><div class="muted">${escapeHtml(t.date)}: ${escapeHtml(item.invoiceDate)} · ${escapeHtml(t.due)}: ${escapeHtml(item.dueDate)}</div></div><div class="money">${escapeHtml(money(item.totalCents,language))}</div></div><div class="grid"><div class="metric"><span>${escapeHtml(t.state)}</span><strong>${escapeHtml(statusLabel(item.payment,language))}</strong></div><div class="metric"><span>${escapeHtml(t.balance)}</span><strong>${escapeHtml(money(item.payment.balanceCents,language))}</strong></div></div><a class="button secondary" href="/portal/invoices/${item.issuedInvoiceId}?lang=${language}">${escapeHtml(t.details)}</a></article>`).join('');
  return page(language,t.welcome,`<section aria-labelledby="published-title"><h2 id="published-title">${escapeHtml(t.invoices)}</h2><div class="cards">${cards||`<div class="panel empty">${escapeHtml(t.empty)}</div>`}</div></section><div class="actions"><form method="post" action="/portal/logout?lang=${language}"><button class="secondary" type="submit">${escapeHtml(t.logout)}</button></form></div>`);
}
function renderDetail(item,language){
  const t=COPY[language];
  return page(language,t.number+' '+item.officialInvoiceNumber,`<article class="panel"><div class="row"><div><div class="number">${escapeHtml(t.number)} ${escapeHtml(item.officialInvoiceNumber)}</div><div class="muted">${escapeHtml(t.date)}: ${escapeHtml(item.invoiceDate)} · ${escapeHtml(t.due)}: ${escapeHtml(item.dueDate)}</div></div><div class="money">${escapeHtml(money(item.totalCents,language))}</div></div><div class="grid"><div class="metric"><span>${escapeHtml(t.paid)}</span><strong>${escapeHtml(money(item.payment.paidCents,language))}</strong></div><div class="metric"><span>${escapeHtml(t.refunded)}</span><strong>${escapeHtml(money(item.payment.refundedCents,language))}</strong></div><div class="metric"><span>${escapeHtml(t.net)}</span><strong>${escapeHtml(money(item.payment.netPaidCents,language))}</strong></div><div class="metric"><span>${escapeHtml(t.balance)}</span><strong>${escapeHtml(money(item.payment.balanceCents,language))}</strong></div></div><p><span class="status">${escapeHtml(statusLabel(item.payment,language))}</span></p><p class="notice" role="note">${escapeHtml(proofNotice(item.payment,language))}</p><p class="hash">SHA-256: ${escapeHtml(item.qualifiedDocumentSha256)}</p><div class="actions"><a class="button" href="/portal/documents/${item.qualifiedDocumentId}.pdf">${escapeHtml(t.pdf)}</a><a class="button secondary" href="/portal?lang=${language}">${escapeHtml(t.back)}</a></div></article>`);
}
function readTokenForm(request){
  return new Promise((resolve,reject)=>{
    let length=0; const chunks=[]; let done=false;
    const declared=request.headers['content-length'];
    if(declared!==undefined && (!/^\d+$/.test(declared)||Number(declared)>MAX_FORM_BYTES)){
      request.resume(); return reject(413);
    }
    request.on('data',chunk=>{
      if(done) return;
      length+=chunk.length;
      if(length>MAX_FORM_BYTES){done=true;request.resume();return reject(413);}
      chunks.push(chunk);
    });
    request.on('error',()=>{if(!done){done=true;reject(400);}});
    request.on('end',()=>{
      if(done) return; done=true;
      try{
        const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        const params=new URLSearchParams(decoded);
        if(params.size!==1 || params.getAll('token').length!==1 || !TOKEN.test(params.get('token'))) return reject(422);
        resolve(params.get('token'));
      }catch{reject(400);}
    });
  });
}

function attachBrowserClientPortal(server,{origin,authStore,readStore}={}){
  if(!server || typeof server.listeners!=='function' || server.listeners('request').length!==1 ||
     typeof origin!=='string' || !/^https:\/\//u.test(origin) || new URL(origin).origin!==origin ||
     !authStore || typeof authStore.redeemAccessLink!=='function' ||
     typeof authStore.revokeSession!=='function' ||
     !readStore || typeof readStore.listInvoices!=='function' ||
     typeof readStore.getInvoice!=='function' || typeof readStore.getQualifiedPdf!=='function'){
    throw new TypeError('HTTPS client portal dependencies required');
  }
  const previous=server.listeners('request')[0];
  server.removeListener('request',previous);
  server.on('request',async(request,response)=>{
    let url;
    try{url=new URL(request.url,'http://localhost');}catch{return previous(request,response);}
    const invoiceMatch=INVOICE_PATH.exec(url.pathname);
    const pdfMatch=PDF_PATH.exec(url.pathname);
    const portalRoute=url.pathname==='/portal';
    const accessRoute=url.pathname==='/portal/access';
    const logoutRoute=url.pathname==='/portal/logout';
    if(!portalRoute && !accessRoute && !logoutRoute && !invoiceMatch && !pdfMatch){
      return previous(request,response);
    }
    if(request.headers.authorization!==undefined || request.headers['x-admin-key']!==undefined){
      return reply(response,401,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
    }

    if(accessRoute && request.method==='GET'){
      const parsed=languageWithToken(url);
      if(!parsed || !safeGet(request,origin)) return reply(response,422,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      return reply(response,200,{'Content-Type':'text/html; charset=utf-8'},renderAccess(parsed.language,parsed.token));
    }

    const language=languageOf(url);
    if(!language) return reply(response,422,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');

    if(accessRoute){
      if(request.method!=='POST') return reply(response,405,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      if(!sameOrigin(request,origin)) return reply(response,403,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      if(!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type']||'')){
        return reply(response,415,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      }
      let token;
      try{token=await readTokenForm(request);}catch(status){
        return reply(response,status===413?413:status===422?422:400,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      }
      try{
        const session=await authStore.redeemAccessLink({token});
        return reply(response,303,{
          Location:'/portal?lang='+language,
          'Set-Cookie':createClientSessionCookie(session.token),
        });
      }catch{
        return reply(response,401,{'Content-Type':'text/html; charset=utf-8'},renderAccess(language,token,true));
      }
    }

    const sessionToken=readClientSessionCookie(request.headers.cookie);
    if(logoutRoute){
      if(request.method!=='POST') return reply(response,405,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      if(!sameOrigin(request,origin)) return reply(response,403,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      try{if(sessionToken) await authStore.revokeSession(sessionToken);}catch{
        return reply(response,503,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
      }
      return reply(response,303,{
        Location:'/portal?lang='+language,
        'Set-Cookie':clearClientSessionCookie(),
      });
    }

    if(request.method!=='GET') return reply(response,405,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
    if(!safeGet(request,origin)) return reply(response,403,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
    if(!sessionToken) return reply(response,401,{'Content-Type':'text/html; charset=utf-8'},renderSignedOut(language));

    try{
      if(portalRoute){
        const invoices=await readStore.listInvoices({sessionToken});
        return reply(response,200,{'Content-Type':'text/html; charset=utf-8'},renderList(invoices,language));
      }
      if(invoiceMatch){
        const invoice=await readStore.getInvoice({sessionToken,issuedInvoiceId:invoiceMatch[1]});
        return reply(response,200,{'Content-Type':'text/html; charset=utf-8'},renderDetail(invoice,language));
      }
      if(pdfMatch){
        const pdf=await readStore.getQualifiedPdf({sessionToken,qualifiedDocumentId:pdfMatch[1]});
        return reply(response,200,{
          'Content-Type':'application/pdf',
          'Content-Length':String(pdf.byteLength),
          'Content-Disposition':'inline; filename="invoice.pdf"',
        },pdf.pdfBytes);
      }
    }catch(error){
      const status=error && Number.isInteger(error.statusCode) ? error.statusCode : 503;
      if(status===401) return reply(response,401,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':clearClientSessionCookie()},renderSignedOut(language));
      if(status===404) return reply(response,404,{'Content-Type':'text/plain; charset=utf-8'},'Not found');
      return reply(response,503,{'Content-Type':'text/plain; charset=utf-8'},'Portal unavailable');
    }
    return reply(response,404,{'Content-Type':'text/plain; charset=utf-8'},'Not found');
  });
  return server;
}

module.exports={
  attachBrowserClientPortal,renderAccess,renderSignedOut,renderList,renderDetail,
  readTokenForm,sameOrigin,
};
