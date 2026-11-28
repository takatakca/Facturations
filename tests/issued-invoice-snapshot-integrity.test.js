'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const {previewDraft}=require('../src/draft-preview');
const {computeDraftPreviewHash}=require('../src/draft-snapshot-integrity');
const {
  createIssuedInvoiceDocumentStore,
  IssuedInvoiceDocumentError,
}=require('../src/issued-invoice-document-store');

const ISSUED='22222222-2222-4222-8222-222222222222';

test('official PDF render fails closed when issued snapshot no longer matches request hash',async()=>{
  const preview=previewDraft({
    currency:'CAD',
    customer:{
      name:'Synthetic Issued Customer',
      email:'issued@example.test',
      address:'123 Example Street',
    },
    invoiceDate:'2026-09-28',
    dueDate:'2026-10-28',
    notes:'Synthetic issued snapshot integrity',
    lines:[{
      description:'Synthetic service',
      quantity:1,
      unitPriceCents:2500,
      discountCents:0,
      taxable:false,
    }],
    taxes:[],
  });
  const requestHash=computeDraftPreviewHash(preview);
  const stored={...preview,status:'DRAFT',persisted:true};
  const tampered={...stored,totalCents:stored.totalCents+1};

  let rendererCalled=false;
  let rolledBack=false;
  let released=false;
  const client={
    async query(sql){
      if(sql==='BEGIN') return {rows:[]};
      if(sql==='ROLLBACK'){rolledBack=true;return {rows:[]};}
      if(sql.includes('FROM facturations_issued_invoices')){
        return {rows:[{
          id:ISSUED,
          authorization_id:'33333333-3333-4333-8333-333333333333',
          draft_id:'44444444-4444-4444-8444-444444444444',
          attempt_id:'55555555-5555-4555-8555-555555555555',
          provider:'WAVE',
          provider_invoice_id:'wave-synthetic',
          official_invoice_number:'SYNTHETIC-001',
          request_hash:requestHash,
          issued_snapshot:tampered,
          status:'ISSUED_CONFIRMED',
          delivery_state:'NOT_AUTHORIZED',
          provider_confirmed_at:new Date('2026-09-28T12:00:00.000Z'),
          materialized_at:new Date('2026-09-28T12:01:00.000Z'),
        }]};
      }
      throw new Error('unexpected query after issued snapshot integrity failure');
    },
    release(){released=true;},
  };
  const pool={
    async connect(){return client;},
    async query(){throw new Error('unexpected pool query');},
  };
  const store=createIssuedInvoiceDocumentStore({
    pool,
    businessId:'synthetic-issued-integrity',
    renderer:async()=>{
      rendererCalled=true;
      throw new Error('renderer must not run');
    },
  });

  await assert.rejects(
    store.materialize({issuedInvoiceId:ISSUED}),
    error=>error instanceof IssuedInvoiceDocumentError &&
      error.code==='ISSUED_SNAPSHOT_STORAGE_INVALID' &&
      error.statusCode===503
  );
  assert.equal(rendererCalled,false);
  assert.equal(rolledBack,true);
  assert.equal(released,true);
});
