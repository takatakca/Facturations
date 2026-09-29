'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const {previewDraft}=require('../src/draft-preview');
const {
  computeDraftPreviewHash,
  verifyPersistedDraftSnapshot,
}=require('../src/draft-snapshot-integrity');

function fixture(){
  const preview=previewDraft({
    currency:'CAD',
    customer:{
      name:'Synthetic Snapshot Customer',
      email:'snapshot@example.test',
      address:'123 Example Street',
    },
    invoiceDate:'2026-09-28',
    dueDate:'2026-10-28',
    notes:'Synthetic snapshot integrity',
    lines:[{
      description:'Synthetic service',
      quantity:2,
      unitPriceCents:2500,
      discountCents:500,
      taxable:true,
    }],
    taxes:[{
      code:'TPS',
      label:'TPS',
      rateMilliPercent:5000,
    }],
  });
  return {
    preview,
    requestHash:computeDraftPreviewHash(preview),
    stored:{...preview,status:'DRAFT',persisted:true},
  };
}

test('persisted draft snapshot reproduces the original request hash',()=>{
  const f=fixture();
  assert.match(f.requestHash,/^[a-f0-9]{64}$/);
  assert.equal(verifyPersistedDraftSnapshot(f.stored,f.requestHash),true);
});

test('snapshot integrity rejects changed totals, source fields, extra fields and wrong hash',()=>{
  const f=fixture();
  assert.equal(
    verifyPersistedDraftSnapshot({...f.stored,totalCents:f.stored.totalCents+1},f.requestHash),
    false
  );
  assert.equal(
    verifyPersistedDraftSnapshot({
      ...f.stored,
      customer:{...f.stored.customer,email:'other@example.test'},
    },f.requestHash),
    false
  );
  assert.equal(
    verifyPersistedDraftSnapshot({...f.stored,unexpected:true},f.requestHash),
    false
  );
  assert.equal(verifyPersistedDraftSnapshot(f.stored,'a'.repeat(64)),false);
});
