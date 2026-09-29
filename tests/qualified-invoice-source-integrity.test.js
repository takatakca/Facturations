'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {
  createQualifiedInvoiceDocumentStore,
  QualifiedInvoiceDocumentError,
}=require('../src/qualified-invoice-document-store');
const {computeIssuerProfileHash}=require('../src/issuer-profile-store');
const {previewDraft}=require('../src/draft-preview');
const {computeDraftPreviewHash}=require('../src/draft-snapshot-integrity');

const ID='11111111-1111-4111-8111-111111111111';
const ISSUED='22222222-2222-4222-8222-222222222222';
const PROFILE='33333333-3333-4333-8333-333333333333';
const SOURCE='44444444-4444-4444-8444-444444444444';

function storedInvoiceSnapshot(){
  const preview=previewDraft({
    currency:'CAD',
    customer:{
      name:'Synthetic Invoice Customer',
      email:'invoice@example.test',
      address:'123 Example Street',
    },
    invoiceDate:'2026-09-28',
    dueDate:'2026-10-28',
    notes:'Synthetic qualified integrity',
    lines:[{
      description:'Synthetic service',
      quantity:1,
      unitPriceCents:1000,
      discountCents:0,
      taxable:false,
    }],
    taxes:[],
  });
  return {
    requestHash:computeDraftPreviewHash(preview),
    snapshot:{...preview,status:'DRAFT',persisted:true},
  };
}

test('qualified PDF creation fails closed when source archive bytes no longer match provenance hash',async()=>{
  const expected=Buffer.concat([
    Buffer.from('%PDF-1.4\n','ascii'),
    Buffer.alloc(128,65),
    Buffer.from('\n%%EOF\n','ascii'),
  ]);
  const corrupted=Buffer.from(expected);
  corrupted[32]=66;
  const expectedHash=crypto.createHash('sha256').update(expected).digest('hex');
  assert.equal(corrupted.length,expected.length);
  assert.notEqual(
    crypto.createHash('sha256').update(corrupted).digest('hex'),
    expectedHash
  );

  const originalProfile={
    legalName:'Synthetic Issuer',
    displayName:null,
    addressLines:['123 Example'],
    city:'Montreal',
    region:'QC',
    postalCode:'H0H0H0',
    countryCode:'CA',
    contactEmail:null,
    contactPhone:null,
    taxRegistrations:[],
  };
  const profileHash=computeIssuerProfileHash(originalProfile);
  const draftIntegrity=storedInvoiceSnapshot();

  let rendererCalled=false;
  let released=false;
  let rolledBack=false;
  const row={
    binding_id:ID,
    issued_invoice_id:ISSUED,
    issuer_profile_id:PROFILE,
    binding_profile_hash:profileHash,
    binding_profile_version:1,
    authorization_id:'55555555-5555-4555-8555-555555555555',
    draft_id:'66666666-6666-4666-8666-666666666666',
    attempt_id:'77777777-7777-4777-8777-777777777777',
    provider:'WAVE',
    provider_invoice_id:'wave-synthetic',
    official_invoice_number:'SYNTHETIC-001',
    request_hash:draftIntegrity.requestHash,
    issued_snapshot:draftIntegrity.snapshot,
    invoice_status:'ISSUED_CONFIRMED',
    invoice_delivery_state:'NOT_AUTHORIZED',
    provider_confirmed_at:new Date('2026-09-28T12:00:00.000Z'),
    invoice_materialized_at:new Date('2026-09-28T12:01:00.000Z'),
    profile_version:1,
    legal_name:originalProfile.legalName,
    display_name:originalProfile.displayName,
    address_lines:originalProfile.addressLines,
    city:'Montreal',
    region:'QC',
    postal_code:originalProfile.postalCode,
    country_code:originalProfile.countryCode,
    contact_email:originalProfile.contactEmail,
    contact_phone:originalProfile.contactPhone,
    tax_registrations:originalProfile.taxRegistrations,
    profile_hash:profileHash,
    profile_state:'VERIFIED',
    source_document_id:SOURCE,
    source_document_sha256:expectedHash,
    source_content_type:'application/pdf',
    source_byte_length:corrupted.length,
    source_pdf_bytes:corrupted,
    source_delivery_state:'NOT_AUTHORIZED',
  };

  const client={
    async query(sql){
      if(sql==='BEGIN') return {rows:[]};
      if(sql==='ROLLBACK'){rolledBack=true;return {rows:[]};}
      if(sql.includes('FROM facturations_invoice_issuer_bindings AS b')){
        return {rows:[row]};
      }
      throw new Error('unexpected query after source provenance failure');
    },
    release(){released=true;},
  };
  const pool={
    async connect(){return client;},
    async query(){throw new Error('unexpected pool query');},
  };
  const store=createQualifiedInvoiceDocumentStore({
    pool,
    businessId:'synthetic-source-integrity',
    renderer:async()=>{
      rendererCalled=true;
      throw new Error('renderer must not run');
    },
  });

  await assert.rejects(
    store.materialize({bindingId:ID}),
    error=>error instanceof QualifiedInvoiceDocumentError &&
      error.code==='SOURCE_DOCUMENT_STORAGE_INVALID' &&
      error.statusCode===503
  );
  assert.equal(rendererCalled,false);
  assert.equal(rolledBack,true);
  assert.equal(released,true);
});


test('qualified PDF creation fails closed when issuer profile fields no longer match stored hash',async()=>{
  const sourceBytes=Buffer.concat([
    Buffer.from('%PDF-1.4\n','ascii'),
    Buffer.alloc(128,65),
    Buffer.from('\n%%EOF\n','ascii'),
  ]);
  const sourceHash=crypto.createHash('sha256').update(sourceBytes).digest('hex');

  const originalProfile={
    legalName:'Original Synthetic Issuer',
    displayName:'Synthetic',
    addressLines:['123 Example'],
    city:'Montreal',
    region:'QC',
    postalCode:'H0H0H0',
    countryCode:'CA',
    contactEmail:'issuer@example.test',
    contactPhone:null,
    taxRegistrations:[],
  };
  const profileHash=computeIssuerProfileHash(originalProfile);
  const draftIntegrity=storedInvoiceSnapshot();

  let rendererCalled=false;
  let rolledBack=false;
  let released=false;
  const row={
    binding_id:ID,
    issued_invoice_id:ISSUED,
    issuer_profile_id:PROFILE,
    binding_profile_hash:profileHash,
    binding_profile_version:1,
    authorization_id:'55555555-5555-4555-8555-555555555555',
    draft_id:'66666666-6666-4666-8666-666666666666',
    attempt_id:'77777777-7777-4777-8777-777777777777',
    provider:'WAVE',
    provider_invoice_id:'wave-synthetic',
    official_invoice_number:'SYNTHETIC-001',
    request_hash:draftIntegrity.requestHash,
    issued_snapshot:draftIntegrity.snapshot,
    invoice_status:'ISSUED_CONFIRMED',
    invoice_delivery_state:'NOT_AUTHORIZED',
    provider_confirmed_at:new Date('2026-09-28T12:00:00.000Z'),
    invoice_materialized_at:new Date('2026-09-28T12:01:00.000Z'),
    profile_version:1,
    legal_name:'Tampered Synthetic Issuer',
    display_name:originalProfile.displayName,
    address_lines:originalProfile.addressLines,
    city:originalProfile.city,
    region:originalProfile.region,
    postal_code:originalProfile.postalCode,
    country_code:originalProfile.countryCode,
    contact_email:originalProfile.contactEmail,
    contact_phone:originalProfile.contactPhone,
    tax_registrations:originalProfile.taxRegistrations,
    profile_hash:profileHash,
    profile_state:'VERIFIED',
    source_document_id:SOURCE,
    source_document_sha256:sourceHash,
    source_content_type:'application/pdf',
    source_byte_length:sourceBytes.length,
    source_pdf_bytes:sourceBytes,
    source_delivery_state:'NOT_AUTHORIZED',
  };

  const client={
    async query(sql){
      if(sql==='BEGIN') return {rows:[]};
      if(sql==='ROLLBACK'){rolledBack=true;return {rows:[]};}
      if(sql.includes('FROM facturations_invoice_issuer_bindings AS b')){
        return {rows:[row]};
      }
      throw new Error('unexpected query after issuer profile integrity failure');
    },
    release(){released=true;},
  };
  const pool={
    async connect(){return client;},
    async query(){throw new Error('unexpected pool query');},
  };
  const store=createQualifiedInvoiceDocumentStore({
    pool,
    businessId:'synthetic-profile-integrity',
    renderer:async()=>{
      rendererCalled=true;
      throw new Error('renderer must not run');
    },
  });

  await assert.rejects(
    store.materialize({bindingId:ID}),
    error=>error instanceof QualifiedInvoiceDocumentError &&
      error.code==='ISSUER_PROFILE_STORAGE_INVALID' &&
      error.statusCode===503
  );
  assert.equal(rendererCalled,false);
  assert.equal(rolledBack,true);
  assert.equal(released,true);
});
