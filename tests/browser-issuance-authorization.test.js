'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../src/server');
const {
  attachBrowserIssuanceAuthorization,
} = require('../src/browser-issuance-authorization');

const ORIGIN='https://fictional.example.test';
const BUSINESS='issuance-browser-fixture';
const TOKEN='A'.repeat(43);
const OWNER='11111111-1111-4111-8111-111111111111';
const ID='22222222-2222-4222-8222-222222222222';
const KEY='b'.repeat(64);
const EMAIL='recipient@example.test';
const PATH=`/internal/review/${ID}/authorize-issuance?lang=fr`;

function draft(){
  return {
    id:ID,status:'DRAFT',
    preview:{
      status:'DRAFT',persisted:true,currency:'CAD',
      customer:{name:'Synthetic & Customer',email:EMAIL,address:'Example only'},
      invoiceDate:'2026-09-23',dueDate:'2026-10-23',
      totalCents:4200,subtotalCents:4200,taxTotalCents:0,lines:[],taxes:[],
    },
  };
}
function fixture(){
  const state={role:'OWNER',revoked:false,approved:true,existing:null,writes:0,captured:null};
  return {
    state,
    staffAuthStore:{async getSession(token){
      return token===TOKEN && !state.revoked ? {id:OWNER,role:state.role,businessId:BUSINESS}:null;
    }},
    draftStore:{async getDraft(id){ if(id!==ID) throw Error('not found'); return draft(); }},
    approvalStore:{async isApproved(input){
      assert.deepEqual(input,{draftId:ID,ownerId:OWNER,sessionToken:TOKEN});
      return state.approved;
    }},
    authorizationStore:{
      async getAuthorization(input){
        assert.deepEqual(input,{draftId:ID,ownerId:OWNER,sessionToken:TOKEN});
        return state.existing;
      },
      async authorize(command){
        state.writes++; state.captured=command;
        state.existing={id:'33333333-3333-4333-8333-333333333333',draftId:ID,
          status:'AUTHORIZED_PENDING_PROVIDER',provider:'WAVE',authorizedBy:OWNER,
          authorizedAt:'2026-09-23T00:00:00.000Z',issued:false,waveSynced:false,emailed:false};
        return state.existing;
      },
    },
  };
}
async function withServer(stores,run){
  const app=createServer({config:{businessId:BUSINESS,adminKey:'synthetic-admin',waveToken:null}});
  attachBrowserIssuanceAuthorization(app,{origin:ORIGIN,businessId:BUSINESS,encryptionKeyHex:KEY,...stores});
  app.listen(0,'127.0.0.1'); await once(app,'listening');
  try{ await run(`http://127.0.0.1:${app.address().port}`); }
  finally{ await new Promise(resolve=>app.close(resolve)); }
}
const getHeaders=(token=TOKEN)=>({Cookie:`__Host-facturations-session=${token}`});
const postHeaders=(token=TOKEN)=>({...getHeaders(token),Host:'fictional.example.test',
  Origin:ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/x-www-form-urlencoded'});
function rawPost(base,path,body,headers=postHeaders()){
  const url=new URL(base+path);
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:url.hostname,port:url.port,path:url.pathname+url.search,method:'POST',
      headers:{...headers,'Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,text:async()=>Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);req.end(body);
  });
}
function csrfOf(html){
  const match=/name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(html);
  assert.ok(match,'issuance CSRF token required'); return match[1];
}
function bodyFor(csrf,overrides={}){
  return new URLSearchParams({
    csrf,
    confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    expectedTotalCents:'4200',
    expectedCustomerEmail:EMAIL,
    provider:'WAVE',
    recipientReviewed:'yes',
    amountReviewed:'yes',
    datesReviewed:'yes',
    taxesReviewed:'yes',
    providerReviewed:'yes',
    ...overrides,
  }).toString();
}

test('issuance authorization page is OWNER-only, post-approval and never performs provider work',async()=>{
  const stores=fixture();
  await withServer(stores,async base=>{
    assert.equal((await fetch(base+PATH)).status,401);
    assert.equal((await fetch(base+PATH,{headers:getHeaders('Z'.repeat(43))})).status,401);
    assert.equal((await fetch(base+PATH,{headers:{...getHeaders(),Authorization:'Bearer x'}})).status,401);
    assert.equal((await fetch(base+PATH,{headers:{...getHeaders(),'X-Admin-Key':'synthetic-admin'}})).status,401);
    stores.state.role='STAFF';
    assert.equal((await fetch(base+PATH,{headers:getHeaders()})).status,403);
    stores.state.role='OWNER';
    stores.state.approved=false;
    assert.equal((await fetch(base+PATH,{headers:getHeaders()})).status,409);
    stores.state.approved=true;
    for(const path of [
      `/internal/review/${ID}/authorize-issuance?lang=es`,
      `/internal/review/${ID}/authorize-issuance?lang=fr&lang=en`,
      '/internal/review/not-a-uuid/authorize-issuance?lang=fr',
    ]) assert.equal((await fetch(base+path,{headers:getHeaders()})).status,422);
    assert.equal(stores.state.writes,0);
  });
});

test('explicit POST requires exact CSRF, origin, immutable details and five acknowledgements',async()=>{
  const stores=fixture();
  await withServer(stores,async base=>{
    const response=await fetch(base+PATH,{headers:getHeaders()});
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(html,/Autoriser la préparation de l’émission/);
    assert.match(html,/ne contacte pas Wave/i);
    assert.match(html,/AUTHORIZE_ISSUANCE_PENDING_PROVIDER/);
    assert.match(html,/name="provider" value="WAVE"/);
    assert.equal((html.match(/type="checkbox"/g)||[]).length,5);
    assert.doesNotMatch(html,/checked/);
    assert.doesNotMatch(html,new RegExp(TOKEN));
    const csrf=csrfOf(html);

    for(const headers of [
      {...postHeaders(),Origin:'https://other.example.test'},
      {...postHeaders(),Host:'other.example.test'},
      {...postHeaders(),'Sec-Fetch-Site':'cross-site'},
    ]) assert.equal((await rawPost(base,PATH,bodyFor(csrf),headers)).status,403);

    assert.equal((await rawPost(base,PATH,bodyFor('X'.repeat(43)))).status,403);
    assert.equal((await rawPost(base,PATH,bodyFor(csrf,{confirmation:'ISSUE_NOW'}))).status,422);
    assert.equal((await rawPost(base,PATH,bodyFor(csrf,{provider:'OTHER'}))).status,422);
    assert.equal((await rawPost(base,PATH,bodyFor(csrf,{providerReviewed:'no'}))).status,422);
    assert.equal((await rawPost(base,PATH,bodyFor(csrf,{expectedTotalCents:'42.00'}))).status,422);
    assert.equal((await rawPost(base,PATH,bodyFor(csrf),{...postHeaders(),'Content-Type':'application/json'})).status,415);
    assert.equal(stores.state.writes,0);

    const accepted=await rawPost(base,PATH,bodyFor(csrf));
    assert.equal(accepted.status,200);
    assert.match(await accepted.text(),/facture demeure non émise/i);
    assert.equal(stores.state.writes,1);
    assert.deepEqual(stores.state.captured,{
      confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      draftId:ID,ownerId:OWNER,sessionToken:TOKEN,
      expectedTotalCents:4200,expectedCustomerEmail:EMAIL,provider:'WAVE',
    });

    const refreshed=await fetch(base+PATH,{headers:getHeaders()});
    assert.equal(refreshed.status,200);
    const refreshedHtml=await refreshed.text();
    assert.match(refreshedHtml,/AUTHORIZED_PENDING_PROVIDER/);
    assert.doesNotMatch(refreshedHtml,/type="checkbox"/);

    stores.state.revoked=true;
    assert.equal((await fetch(base+PATH,{headers:getHeaders()})).status,401);
  });
});

test('invalid route wiring fails closed',()=>{
  assert.throws(()=>attachBrowserIssuanceAuthorization(createServer({config:{}}),{
    origin:'http://fictional.example.test',businessId:BUSINESS,encryptionKeyHex:KEY,
    staffAuthStore:{getSession(){}},draftStore:{getDraft(){}},
    approvalStore:{isApproved(){}},authorizationStore:{authorize(){},getAuthorization(){}},
  }),/Dedicated owner issuance authorization/);
});
