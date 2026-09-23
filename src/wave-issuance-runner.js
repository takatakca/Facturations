'use strict';

class WaveIssuanceRunnerError extends Error {
  constructor(code,statusCode=422){
    super(code);this.name='WaveIssuanceRunnerError';this.code=code;this.statusCode=statusCode;
  }
}
const SAFE_CODE=/^[A-Z0-9_:-]{1,100}$/;
function boundedText(value,max,code){
  if(typeof value!=='string'||value.length<1||value.length>max||/[\u0000-\u001f\u007f]/u.test(value)){
    throw new WaveIssuanceRunnerError(code);
  }
  return value;
}
function validatePlan(plan){
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||
     plan.status!=='READY_FOR_WAVE_ADAPTER'||
     plan.operation!=='CREATE_DRAFT_THEN_APPROVE_SEPARATELY'||
     plan.currency!=='CAD'||!Array.isArray(plan.items)||plan.items.length<1||
     !plan.expected||typeof plan.expected!=='object'||
     !plan.externalActionsPerformed||
     plan.externalActionsPerformed.createInvoice!==false||
     plan.externalActionsPerformed.approveInvoice!==false||
     plan.externalActionsPerformed.sendInvoice!==false){
    throw new WaveIssuanceRunnerError('INVALID_WAVE_PLAN');
  }
  boundedText(plan.businessId,512,'INVALID_WAVE_BUSINESS_ID');
  boundedText(plan.customerId,512,'INVALID_WAVE_CUSTOMER_ID');
  if(!Number.isSafeInteger(plan.expected.totalCents)||plan.expected.totalCents<0||
     !Number.isSafeInteger(plan.expected.taxTotalCents)||plan.expected.taxTotalCents<0||
     !Number.isSafeInteger(plan.expected.subtotalCents)||plan.expected.subtotalCents<0){
    throw new WaveIssuanceRunnerError('INVALID_WAVE_TOTALS');
  }
  return plan;
}
function validateDeps(attemptStore,adapter){
  if(!attemptStore||typeof attemptStore.start!=='function'||
     typeof attemptStore.recordOutcome!=='function'||typeof attemptStore.reconcile!=='function'){
    throw new TypeError('Provider attempt store required');
  }
  if(!adapter||typeof adapter.issueAuthorizedInvoice!=='function'||
     typeof adapter.reconcileAuthorizedInvoice!=='function'){
    throw new TypeError('Injected Wave issuance adapter required');
  }
}
function safeFailureCode(value,fallback){
  return typeof value==='string'&&SAFE_CODE.test(value)?value:fallback;
}
function normalizedConfirmed(result,plan){
  if(!result||typeof result!=='object'||Array.isArray(result)||
     Object.keys(result).sort().join(',')!==
       'currency,customerId,invoiceId,invoiceNumber,kind,taxTotalCents,totalCents'){
    throw new WaveIssuanceRunnerError('INVALID_PROVIDER_RESULT',502);
  }
  const invoiceId=boundedText(result.invoiceId,512,'INVALID_PROVIDER_RESULT');
  const invoiceNumber=boundedText(result.invoiceNumber,200,'INVALID_PROVIDER_RESULT');
  boundedText(result.customerId,512,'INVALID_PROVIDER_RESULT');
  if(result.currency!=='CAD'||!Number.isSafeInteger(result.totalCents)||
     !Number.isSafeInteger(result.taxTotalCents)){
    throw new WaveIssuanceRunnerError('INVALID_PROVIDER_RESULT',502);
  }
  if(result.customerId!==plan.customerId||result.totalCents!==plan.expected.totalCents||
     result.taxTotalCents!==plan.expected.taxTotalCents){
    return Object.freeze({
      match:false,invoiceId:null,invoiceNumber:null,
      errorCode:'WAVE_RESULT_MISMATCH',
    });
  }
  return Object.freeze({match:true,invoiceId,invoiceNumber,errorCode:null});
}
function validateFailure(result){
  if(!result||typeof result!=='object'||Array.isArray(result)||
     Object.keys(result).sort().join(',')!=='code,kind'||
     !['AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL'].includes(result.kind)||
     typeof result.code!=='string'||!SAFE_CODE.test(result.code)){
    throw new WaveIssuanceRunnerError('INVALID_PROVIDER_RESULT',502);
  }
  return result;
}
async function executePreparedWaveIssuance({attemptId,plan},{attemptStore,adapter}){
  validateDeps(attemptStore,adapter);
  validatePlan(plan);
  const started=await attemptStore.start({attemptId});
  if(!started||started.state!=='IN_FLIGHT'||started.provider!=='WAVE'||
     started.operation!=='ISSUE_INVOICE'){
    throw new WaveIssuanceRunnerError('ATTEMPT_NOT_READY',409);
  }
  let result;
  try{
    result=await adapter.issueAuthorizedInvoice({
      plan,
      localAttempt:Object.freeze({id:started.id,attemptNo:started.attemptNo}),
    });
  }catch(error){
    return attemptStore.recordOutcome({
      attemptId:started.id,outcome:'AMBIGUOUS',
      providerInvoiceId:null,providerInvoiceNumber:null,
      errorCode:safeFailureCode(error?.code,'WAVE_UNKNOWN_RESULT'),
    });
  }

  if(result?.kind==='CONFIRMED'){
    const confirmed=normalizedConfirmed(result,plan);
    if(!confirmed.match){
      return attemptStore.recordOutcome({
        attemptId:started.id,outcome:'AMBIGUOUS',
        providerInvoiceId:null,providerInvoiceNumber:null,
        errorCode:confirmed.errorCode,
      });
    }
    return attemptStore.recordOutcome({
      attemptId:started.id,outcome:'CONFIRMED',
      providerInvoiceId:confirmed.invoiceId,
      providerInvoiceNumber:confirmed.invoiceNumber,
      errorCode:null,
    });
  }

  const failure=validateFailure(result);
  return attemptStore.recordOutcome({
    attemptId:started.id,outcome:failure.kind,
    providerInvoiceId:null,providerInvoiceNumber:null,
    errorCode:failure.code,
  });
}

async function reconcileAmbiguousWaveIssuance({attemptId,plan},{attemptStore,adapter}){
  validateDeps(attemptStore,adapter);
  validatePlan(plan);
  let result;
  try{
    result=await adapter.reconcileAuthorizedInvoice({plan,localAttemptId:attemptId});
  }catch(error){
    throw new WaveIssuanceRunnerError(
      safeFailureCode(error?.code,'WAVE_RECONCILIATION_UNAVAILABLE'),503);
  }
  if(!result||typeof result!=='object'||Array.isArray(result)){
    throw new WaveIssuanceRunnerError('INVALID_RECONCILIATION_RESULT',502);
  }
  if(result.kind==='NOT_FOUND'){
    if(Object.keys(result).sort().join(',')!=='kind'){
      throw new WaveIssuanceRunnerError('INVALID_RECONCILIATION_RESULT',502);
    }
    return attemptStore.reconcile({
      attemptId,result:'NOT_FOUND',providerInvoiceId:null,providerInvoiceNumber:null,
    });
  }
  if(result.kind==='FOUND'){
    const confirmed=normalizedConfirmed(result,plan);
    if(!confirmed.match){
      throw new WaveIssuanceRunnerError('WAVE_RECONCILIATION_MISMATCH',409);
    }
    return attemptStore.reconcile({
      attemptId,result:'FOUND',
      providerInvoiceId:confirmed.invoiceId,
      providerInvoiceNumber:confirmed.invoiceNumber,
    });
  }
  if(result.kind==='UNKNOWN'){
    if(Object.keys(result).sort().join(',')!=='code,kind'||
       typeof result.code!=='string'||!SAFE_CODE.test(result.code)){
      throw new WaveIssuanceRunnerError('INVALID_RECONCILIATION_RESULT',502);
    }
    throw new WaveIssuanceRunnerError(result.code,503);
  }
  throw new WaveIssuanceRunnerError('INVALID_RECONCILIATION_RESULT',502);
}

module.exports={
  executePreparedWaveIssuance,
  reconcileAmbiguousWaveIssuance,
  WaveIssuanceRunnerError,
};
