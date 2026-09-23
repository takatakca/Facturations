'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {previewDraft}=require('../src/draft-preview');
const {buildWaveIssuancePreflight}=require('../src/wave-issuance-preflight');
const {
  executePreparedWaveIssuance,
  reconcileAmbiguousWaveIssuance,
  WaveIssuanceRunnerError,
}=require('../src/wave-issuance-runner');

const ATTEMPT='11111111-1111-4111-8111-111111111111';

function plan(){
  const snapshot={...previewDraft({
    currency:'CAD',
    customer:{name:'Synthetic',email:'customer@example.test',address:'Example only'},
    invoiceDate:'2026-09-23',dueDate:'2026-10-23',notes:'Synthetic only',
    lines:[{description:'Service',quantity:2,unitPriceCents:1500,taxable:true}],
    taxes:[{code:'GST',label:'Synthetic GST',rateMilliPercent:5000}],
  }),status:'DRAFT',persisted:true};
  return buildWaveIssuancePreflight({
    snapshot,
    businessId:'wave-business',
    customerId:'wave-customer',
    productIds:['wave-product'],
    salesTaxes:{GST:{id:'wave-tax',rateMilliPercent:5000}},
  });
}
function attemptStore(){
  const state={startCalls:0,outcomes:[],reconciles:[]};
  return {
    state,
    async start({attemptId}){
      state.startCalls++;
      assert.equal(attemptId,ATTEMPT);
      return {id:ATTEMPT,state:'IN_FLIGHT',provider:'WAVE',operation:'ISSUE_INVOICE',attemptNo:1};
    },
    async recordOutcome(input){state.outcomes.push(input);return {...input,state:input.outcome};},
    async reconcile(input){state.reconciles.push(input);return {...input,state:input.result};},
  };
}
function adapter(result){
  const state={issueCalls:0,reconcileCalls:0,sendCalls:0};
  return {
    state,
    async issueAuthorizedInvoice(input){state.issueCalls++;state.issueInput=input;
      if(result instanceof Error) throw result;
      return typeof result==='function'?result(input):result;
    },
    async reconcileAuthorizedInvoice(input){state.reconcileCalls++;state.reconcileInput=input;
      const value=state.reconcileResult;
      if(value instanceof Error) throw value;
      return value;
    },
    async sendInvoice(){state.sendCalls++;throw Error('send must never be called');},
  };
}
function confirmed(overrides={}){
  return {
    kind:'CONFIRMED',
    invoiceId:'wave-invoice-id',
    invoiceNumber:'1001',
    customerId:'wave-customer',
    currency:'CAD',
    totalCents:3150,
    taxTotalCents:150,
    ...overrides,
  };
}

test('confirmed simulated provider result is recorded only after exact total/customer reconciliation',async()=>{
  const store=attemptStore();
  const wave=adapter(confirmed());
  const result=await executePreparedWaveIssuance({attemptId:ATTEMPT,plan:plan()},
    {attemptStore:store,adapter:wave});
  assert.equal(store.state.startCalls,1);
  assert.equal(wave.state.issueCalls,1);
  assert.equal(wave.state.sendCalls,0);
  assert.equal(store.state.outcomes.length,1);
  assert.deepEqual(store.state.outcomes[0],{
    attemptId:ATTEMPT,outcome:'CONFIRMED',
    providerInvoiceId:'wave-invoice-id',providerInvoiceNumber:'1001',errorCode:null,
  });
  assert.equal(result.state,'CONFIRMED');
  assert.deepEqual(wave.state.issueInput.localAttempt,{id:ATTEMPT,attemptNo:1});
});

test('mismatched provider total or customer is ambiguous, never confirmed',async()=>{
  for(const bad of [
    confirmed({totalCents:3151}),
    confirmed({customerId:'other-customer'}),
    confirmed({taxTotalCents:149}),
  ]){
    const store=attemptStore();
    const wave=adapter(bad);
    await executePreparedWaveIssuance({attemptId:ATTEMPT,plan:plan()},
      {attemptStore:store,adapter:wave});
    assert.deepEqual(store.state.outcomes[0],{
      attemptId:ATTEMPT,outcome:'AMBIGUOUS',
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:'WAVE_RESULT_MISMATCH',
    });
    assert.equal(wave.state.sendCalls,0);
  }
});

test('timeout or unknown thrown result becomes ambiguous rather than auto-retried',async()=>{
  for(const thrown of [
    Object.assign(new Error('timeout'),{code:'WAVE_TIMEOUT'}),
    new Error('unknown provider state'),
  ]){
    const store=attemptStore();
    const wave=adapter(thrown);
    await executePreparedWaveIssuance({attemptId:ATTEMPT,plan:plan()},
      {attemptStore:store,adapter:wave});
    assert.equal(store.state.outcomes[0].outcome,'AMBIGUOUS');
    assert.ok(['WAVE_TIMEOUT','WAVE_UNKNOWN_RESULT'].includes(store.state.outcomes[0].errorCode));
    assert.equal(store.state.startCalls,1);
    assert.equal(wave.state.issueCalls,1);
  }
});

test('structured provider failures preserve retryable/final/ambiguous categories',async()=>{
  for(const item of [
    {kind:'FAILED_RETRYABLE',code:'WAVE_RATE_LIMITED'},
    {kind:'FAILED_FINAL',code:'WAVE_ACCESS_DENIED'},
    {kind:'AMBIGUOUS',code:'WAVE_UPSTREAM_UNKNOWN'},
  ]){
    const store=attemptStore();
    const wave=adapter(item);
    await executePreparedWaveIssuance({attemptId:ATTEMPT,plan:plan()},
      {attemptStore:store,adapter:wave});
    assert.deepEqual(store.state.outcomes[0],{
      attemptId:ATTEMPT,outcome:item.kind,
      providerInvoiceId:null,providerInvoiceNumber:null,errorCode:item.code,
    });
  }
});

test('invalid post-start provider payload becomes ambiguous and requires reconciliation',async()=>{
  const store=attemptStore();
  const wave=adapter({kind:'CONFIRMED',invoiceId:'id'});
  const result=await executePreparedWaveIssuance(
    {attemptId:ATTEMPT,plan:plan()},{attemptStore:store,adapter:wave}
  );
  assert.deepEqual(store.state.outcomes[0],{
    attemptId:ATTEMPT,outcome:'AMBIGUOUS',
    providerInvoiceId:null,providerInvoiceNumber:null,
    errorCode:'WAVE_INVALID_PROVIDER_RESULT',
  });
  assert.equal(result.state,'AMBIGUOUS');
});

test('reconciliation NOT_FOUND unlock signal is delegated to state machine, without retrying here',async()=>{
  const store=attemptStore();
  const wave=adapter(null);
  wave.state.reconcileResult={kind:'NOT_FOUND'};
  const result=await reconcileAmbiguousWaveIssuance({attemptId:ATTEMPT,plan:plan()},
    {attemptStore:store,adapter:wave});
  assert.equal(wave.state.reconcileCalls,1);
  assert.deepEqual(store.state.reconciles[0],{
    attemptId:ATTEMPT,result:'NOT_FOUND',providerInvoiceId:null,providerInvoiceNumber:null,
  });
  assert.equal(store.state.startCalls,0);
  assert.equal(wave.state.issueCalls,0);
  assert.equal(result.state,'NOT_FOUND');
});

test('reconciliation FOUND requires the same verified customer/totals before confirmation',async()=>{
  const store=attemptStore();
  const wave=adapter(null);
  wave.state.reconcileResult=confirmed();
  await reconcileAmbiguousWaveIssuance({attemptId:ATTEMPT,plan:plan()},
    {attemptStore:store,adapter:wave});
  assert.deepEqual(store.state.reconciles[0],{
    attemptId:ATTEMPT,result:'FOUND',
    providerInvoiceId:'wave-invoice-id',providerInvoiceNumber:'1001',
  });

  const badStore=attemptStore();
  const badWave=adapter(null);
  badWave.state.reconcileResult=confirmed({totalCents:9999});
  await assert.rejects(
    reconcileAmbiguousWaveIssuance({attemptId:ATTEMPT,plan:plan()},
      {attemptStore:badStore,adapter:badWave}),
    error=>error instanceof WaveIssuanceRunnerError &&
      error.code==='WAVE_RECONCILIATION_MISMATCH' && error.statusCode===409
  );
  assert.equal(badStore.state.reconciles.length,0);
});

test('unknown reconciliation result remains unresolved and never creates a retry',async()=>{
  const store=attemptStore();
  const wave=adapter(null);
  wave.state.reconcileResult={kind:'UNKNOWN',code:'WAVE_RECONCILIATION_TIMEOUT'};
  await assert.rejects(
    reconcileAmbiguousWaveIssuance({attemptId:ATTEMPT,plan:plan()},
      {attemptStore:store,adapter:wave}),
    error=>error instanceof WaveIssuanceRunnerError &&
      error.code==='WAVE_RECONCILIATION_TIMEOUT' && error.statusCode===503
  );
  assert.equal(store.state.reconciles.length,0);
  assert.equal(store.state.startCalls,0);
});
