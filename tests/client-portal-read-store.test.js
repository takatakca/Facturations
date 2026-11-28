'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {
  createClientPortalReadStore,
  ClientPortalReadError,
}=require('../src/client-portal-read-store');

const BUSINESS='portal-integrity-test';
const CUSTOMER='11111111-1111-4111-8111-111111111111';
const DOCUMENT='22222222-2222-4222-8222-222222222222';
const SESSION='A'.repeat(43);

function storeWithRow(row){
  const authStore={
    async getSession(token){
      assert.equal(token,SESSION);
      return {businessId:BUSINESS,customerId:CUSTOMER};
    },
  };
  const pool={
    async query(){
      return {rows:[row]};
    },
  };
  return createClientPortalReadStore({pool,businessId:BUSINESS,authStore});
}

function pdfRow(bytes,hash){
  return {
    id:DOCUMENT,
    issued_invoice_id:'33333333-3333-4333-8333-333333333333',
    content_type:'application/pdf',
    content_sha256:hash,
    byte_length:bytes.length,
    pdf_bytes:bytes,
  };
}

test('portal PDF read verifies stored bytes against SHA-256 before returning them',async()=>{
  const bytes=Buffer.from('%PDF-1.4\nsynthetic\n%%EOF\n','ascii');
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const store=storeWithRow(pdfRow(bytes,hash));

  const result=await store.getQualifiedPdf({
    sessionToken:SESSION,
    qualifiedDocumentId:DOCUMENT,
  });

  assert.equal(result.contentSha256,hash);
  assert.deepEqual(result.pdfBytes,bytes);
});

test('portal PDF read fails closed when stored bytes no longer match provenance hash',async()=>{
  const authorized=Buffer.from('%PDF-1.4\nauthorized\n%%EOF\n','ascii');
  const corrupted=Buffer.from('%PDF-1.4\ncorrupted!\n%%EOF\n','ascii');
  assert.equal(authorized.length,corrupted.length);
  const hash=crypto.createHash('sha256').update(authorized).digest('hex');
  const store=storeWithRow(pdfRow(corrupted,hash));

  await assert.rejects(
    store.getQualifiedPdf({
      sessionToken:SESSION,
      qualifiedDocumentId:DOCUMENT,
    }),
    error=>error instanceof ClientPortalReadError &&
      error.code==='PORTAL_PDF_STORAGE_INVALID' &&
      error.statusCode===503,
  );
});
