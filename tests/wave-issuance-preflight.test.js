'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { previewDraft }=require('../src/draft-preview');
const {
  buildWaveIssuancePreflight,
  WaveIssuancePreflightError,
}=require('../src/wave-issuance-preflight');

function snapshot({discount=0,taxes=true}={}){
  const p=previewDraft({
    currency:'CAD',
    customer:{name:'Synthetic Customer',email:'customer@example.test',address:'Example only'},
    invoiceDate:'2026-09-23',
    dueDate:'2026-10-23',
    notes:'Synthetic preflight only',
    lines:[
      {description:'Taxable synthetic service',quantity:2,unitPriceCents:1500,discountCents:discount,taxable:true},
      {description:'Non-taxable synthetic service',quantity:1,unitPriceCents:500,discountCents:0,taxable:false},
    ],
    taxes:taxes ? [
      {code:'GST',label:'Synthetic GST',rateMilliPercent:5000},
      {code:'QST',label:'Synthetic QST',rateMilliPercent:9975},
    ] : [],
  });
  return {...p,status:'DRAFT',persisted:true};
}
function mappings(){
  return {
    businessId:'wave-business-fixture',
    customerId:'wave-customer-fixture',
    productIds:['wave-product-1','wave-product-2'],
    salesTaxes:{
      GST:{id:'wave-tax-gst',rateMilliPercent:5000},
      QST:{id:'wave-tax-qst',rateMilliPercent:9975},
    },
  };
}
function expectCode(work,code,statusCode=422){
  assert.throws(work,error=>error instanceof WaveIssuancePreflightError &&
    error.code===code && error.statusCode===statusCode);
}

test('builds a no-network provider plan only when every mapping is exact',()=>{
  const draft=snapshot();
  const plan=buildWaveIssuancePreflight({snapshot:draft,...mappings()});
  assert.equal(plan.status,'READY_FOR_WAVE_ADAPTER');
  assert.equal(plan.operation,'CREATE_DRAFT_THEN_APPROVE_SEPARATELY');
  assert.equal(plan.currency,'CAD');
  assert.equal(plan.expected.customerEmail,'customer@example.test');
  assert.equal(plan.expected.totalCents,draft.totalCents);
  assert.deepEqual(plan.externalActionsPerformed,{
    createInvoice:false,approveInvoice:false,sendInvoice:false,
  });
  assert.deepEqual(plan.items[0].salesTaxIds,['wave-tax-gst','wave-tax-qst']);
  assert.deepEqual(plan.items[1].salesTaxIds,[]);
  assert.equal(plan.items[0].unitPriceCents,1500);
  assert.equal(plan.items[0].quantity,2);
});

test('refuses missing customer, product and exact sales-tax mappings',()=>{
  const draft=snapshot();
  const base=mappings();
  expectCode(()=>buildWaveIssuancePreflight({...base,snapshot:draft,customerId:''}),
    'WAVE_CUSTOMER_ID_REQUIRED');
  expectCode(()=>buildWaveIssuancePreflight({...base,snapshot:draft,productIds:['only-one']}),
    'WAVE_PRODUCT_MAPPING_REQUIRED');
  expectCode(()=>buildWaveIssuancePreflight({...base,snapshot:draft,salesTaxes:{
    GST:base.salesTaxes.GST,
  }}),'WAVE_TAX_MAPPING_REQUIRED');
  expectCode(()=>buildWaveIssuancePreflight({...base,snapshot:draft,salesTaxes:{
    ...base.salesTaxes,
    QST:{id:'wave-tax-qst',rateMilliPercent:9976},
  }}),'WAVE_TAX_RATE_MISMATCH',409);
  expectCode(()=>buildWaveIssuancePreflight({...base,snapshot:draft,salesTaxes:{
    ...base.salesTaxes,
    EXTRA:{id:'wave-tax-extra',rateMilliPercent:1},
  }}),'WAVE_TAX_MAPPING_MISMATCH');
});

test('refuses line discounts rather than approximating Wave invoice-level discount semantics',()=>{
  const draft=snapshot({discount:100});
  expectCode(()=>buildWaveIssuancePreflight({snapshot:draft,...mappings()}),
    'WAVE_LINE_DISCOUNT_UNSUPPORTED',409);
});

test('recalculates immutable totals before producing any provider plan',()=>{
  const draft=snapshot();
  draft.totalCents+=1;
  expectCode(()=>buildWaveIssuancePreflight({snapshot:draft,...mappings()}),
    'IMMUTABLE_TOTAL_MISMATCH',409);
});

test('supports deliberately tax-free drafts without inventing tax ids',()=>{
  const draft=snapshot({taxes:false});
  const map=mappings();
  const plan=buildWaveIssuancePreflight({
    snapshot:draft,businessId:map.businessId,customerId:map.customerId,
    productIds:map.productIds,salesTaxes:{},
  });
  assert.deepEqual(plan.items[0].salesTaxIds,[]);
  assert.equal(plan.expected.taxTotalCents,0);
});

test('requires persisted DRAFT snapshot and rejects malformed identifiers',()=>{
  const base=mappings();
  const notPersisted={...snapshot(),persisted:false};
  expectCode(()=>buildWaveIssuancePreflight({snapshot:notPersisted,...base}),
    'IMMUTABLE_DRAFT_REQUIRED');
  expectCode(()=>buildWaveIssuancePreflight({snapshot:snapshot(),...base,businessId:'bad\nvalue'}),
    'WAVE_BUSINESS_ID_REQUIRED');
});
