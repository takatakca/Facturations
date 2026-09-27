'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');

const {attachBrowserClientPortal}=require('../src/browser-client-portal');

const ORIGIN='https://portal.example.test';
const ACCESS_TOKEN='T'.repeat(43);
const SESSION_TOKEN='S'.repeat(43);
const INVOICE_ID='11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID='22222222-2222-4222-8222-222222222222';

function request(port,{method='GET',path='/',headers={},body=''}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({
      host:'127.0.0.1',port,method,path,
      headers:{Host:'portal.example.test',...headers},
    },res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({
        status:res.statusCode,
        headers:res.headers,
        body:Buffer.concat(chunks),
      }));
    });
    req.on('error',reject);
    if(body) req.write(body);
    req.end();
  });
}

test('client portal browser flow confirms link, uses secure cookie, lists scoped invoices and serves PDF',async()=>{
  let redeemed=0;
  let revoked=0;
  const authStore={
    async redeemAccessLink({token}){
      redeemed+=1;
      assert.equal(token,ACCESS_TOKEN);
      return {token:SESSION_TOKEN,customer:{id:'c1'},expiresAt:new Date(Date.now()+3600000).toISOString()};
    },
    async revokeSession(token){
      assert.equal(token,SESSION_TOKEN);
      revoked+=1;
      return true;
    },
  };
  const invoice={
    issuedInvoiceId:INVOICE_ID,
    qualifiedDocumentId:DOCUMENT_ID,
    officialInvoiceNumber:'INV-2026-0001',
    invoiceDate:'2026-09-26',
    dueDate:'2026-10-26',
    currency:'CAD',
    totalCents:12345,
    qualifiedDocumentSha256:'a'.repeat(64),
    publishedAt:'2026-09-26T12:00:00.000Z',
    payment:{
      paidCents:5000,refundedCents:0,netPaidCents:5000,balanceCents:7345,
      financialState:'PARTIALLY_PAID',proofScope:'SYNTHETIC_ONLY',externallyVerified:false,
    },
  };
  const readStore={
    async listInvoices({sessionToken}){assert.equal(sessionToken,SESSION_TOKEN);return [invoice];},
    async getInvoice({sessionToken,issuedInvoiceId}){
      assert.equal(sessionToken,SESSION_TOKEN);
      assert.equal(issuedInvoiceId,INVOICE_ID);
      return invoice;
    },
    async getQualifiedPdf({sessionToken,qualifiedDocumentId}){
      assert.equal(sessionToken,SESSION_TOKEN);
      assert.equal(qualifiedDocumentId,DOCUMENT_ID);
      const pdf=Buffer.from('%PDF-1.4\nsynthetic\n%%EOF\n','ascii');
      return {qualifiedDocumentId,issuedInvoiceId:INVOICE_ID,contentType:'application/pdf',
        contentSha256:'b'.repeat(64),byteLength:pdf.length,pdfBytes:pdf};
    },
  };

  const server=http.createServer((req,res)=>{res.writeHead(404);res.end('fallback');});
  attachBrowserClientPortal(server,{origin:ORIGIN,authStore,readStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  try{
    const access=await request(port,{path:'/portal/access?lang=fr&token='+ACCESS_TOKEN});
    assert.equal(access.status,200);
    assert.equal(redeemed,0,'GET must not consume a magic link');
    assert.match(access.body.toString(),/Continuer vers mes factures/);
    assert.match(access.body.toString(),new RegExp('/portal/access\\?lang=en&amp;token='+ACCESS_TOKEN));

    const body='token='+ACCESS_TOKEN;
    const redeem=await request(port,{
      method:'POST',path:'/portal/access?lang=fr',
      headers:{
        Origin:ORIGIN,
        'Sec-Fetch-Site':'same-origin',
        'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length':Buffer.byteLength(body),
      },body,
    });
    assert.equal(redeem.status,303);
    assert.equal(redeemed,1);
    assert.equal(redeem.headers.location,'/portal?lang=fr');
    const cookie=redeem.headers['set-cookie'][0].split(';')[0];

    const list=await request(port,{path:'/portal?lang=fr',headers:{Cookie:cookie}});
    assert.equal(list.status,200);
    assert.match(list.body.toString(),/INV-2026-0001/);
    assert.match(list.body.toString(),/Partiellement payée/);
    assert.match(list.body.toString(),/preuves de test synthétiques/);

    const detail=await request(port,{path:'/portal/invoices/'+INVOICE_ID+'?lang=en',headers:{Cookie:cookie}});
    assert.equal(detail.status,200);
    assert.match(detail.body.toString(),/Partially paid/);
    assert.match(detail.body.toString(),/CA\$123\.45/);

    const pdf=await request(port,{path:'/portal/documents/'+DOCUMENT_ID+'.pdf',headers:{Cookie:cookie}});
    assert.equal(pdf.status,200);
    assert.equal(pdf.headers['content-type'],'application/pdf');
    assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');

    const logout=await request(port,{
      method:'POST',path:'/portal/logout?lang=fr',
      headers:{Cookie:cookie,Origin:ORIGIN,'Sec-Fetch-Site':'same-origin'},
    });
    assert.equal(logout.status,303);
    assert.equal(revoked,1);
    assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('client portal rejects direct sessionless access and cross-origin redemption',async()=>{
  const authStore={
    async redeemAccessLink(){throw new Error('must not be called');},
    async revokeSession(){return false;},
  };
  const readStore={
    async listInvoices(){throw new Error('must not be called');},
    async getInvoice(){throw new Error('must not be called');},
    async getQualifiedPdf(){throw new Error('must not be called');},
  };
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end('fallback');});
  attachBrowserClientPortal(server,{origin:ORIGIN,authStore,readStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  try{
    const noSession=await request(port,{path:'/portal?lang=en'});
    assert.equal(noSession.status,401);
    assert.match(noSession.body.toString(),/Secure access required/);

    const body='token='+ACCESS_TOKEN;
    const cross=await request(port,{
      method:'POST',path:'/portal/access?lang=en',
      headers:{
        Origin:'https://evil.example.test',
        'Content-Type':'application/x-www-form-urlencoded',
        'Content-Length':Buffer.byteLength(body),
      },body,
    });
    assert.equal(cross.status,403);

    const injected=await request(port,{path:'/portal?lang=en&customerId=anything'});
    assert.equal(injected.status,422);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});
