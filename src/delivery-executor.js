'use strict';

const { DeliveryAttemptError } = require('./delivery-attempt-store');

class DeliveryExecutorError extends Error {
  constructor(code,statusCode=422){
    super(code);
    this.name='DeliveryExecutorError';
    this.code=code;
    this.statusCode=statusCode;
  }
}

function normalizeOutcome(result){
  if(!result || typeof result!=='object' || Array.isArray(result) || typeof result.status!=='string'){
    return Object.freeze({status:'AMBIGUOUS',reasonCode:'ADAPTER_RESULT_INVALID'});
  }
  if(result.status==='CONFIRMED'){
    if(typeof result.providerMessageId!=='string'){
      return Object.freeze({status:'AMBIGUOUS',reasonCode:'ADAPTER_RESULT_INVALID'});
    }
    return Object.freeze({status:'CONFIRMED',providerMessageId:result.providerMessageId});
  }
  if(result.status==='FAILED' || result.status==='AMBIGUOUS'){
    if(typeof result.reasonCode!=='string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(result.reasonCode)){
      return Object.freeze({status:'AMBIGUOUS',reasonCode:'ADAPTER_RESULT_INVALID'});
    }
    return Object.freeze({status:result.status,reasonCode:result.reasonCode});
  }
  return Object.freeze({status:'AMBIGUOUS',reasonCode:'ADAPTER_RESULT_INVALID'});
}

function createDeliveryExecutor({attemptStore,adapter}){
  if(!attemptStore || typeof attemptStore.start!=='function' ||
     typeof attemptStore.markAmbiguous!=='function' ||
     typeof attemptStore.markFailed!=='function' ||
     typeof attemptStore.markConfirmed!=='function' ||
     typeof attemptStore.get!=='function'){
    throw new TypeError('Persistent delivery attempt store required');
  }
  if(!adapter || typeof adapter.sendDocument!=='function'){
    throw new TypeError('Injected delivery adapter required');
  }

  async function execute(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='attemptId'){
      throw new DeliveryExecutorError('INVALID_EXECUTION_REQUEST');
    }
    let started;
    try{
      started=await attemptStore.start({attemptId:input.attemptId});
    }catch(error){
      if(error instanceof DeliveryAttemptError) throw error;
      throw new DeliveryExecutorError('ATTEMPT_START_FAILED',503);
    }

    let outcome;
    try{
      outcome=normalizeOutcome(await adapter.sendDocument(Object.freeze({
        operationKey:started.operationKey,
        provider:started.provider,
        attemptId:started.id,
        authorizationId:started.authorizationId,
        issuedInvoiceId:started.issuedInvoiceId,
        qualifiedDocumentId:started.qualifiedDocumentId,
      })));
    }catch{
      outcome=Object.freeze({status:'AMBIGUOUS',reasonCode:'ADAPTER_EXCEPTION'});
    }

    if(outcome.status==='CONFIRMED'){
      return attemptStore.markConfirmed({
        attemptId:started.id,
        providerMessageId:outcome.providerMessageId,
      });
    }
    if(outcome.status==='FAILED'){
      return attemptStore.markFailed({attemptId:started.id,reasonCode:outcome.reasonCode});
    }
    return attemptStore.markAmbiguous({attemptId:started.id,reasonCode:outcome.reasonCode});
  }

  async function reconcile(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='attemptId,result'){
      throw new DeliveryExecutorError('INVALID_RECONCILIATION_REQUEST');
    }
    const current=await attemptStore.get({attemptId:input.attemptId});
    if(current.state!=='AMBIGUOUS'){
      throw new DeliveryExecutorError('AMBIGUOUS_ATTEMPT_REQUIRED',409);
    }
    const outcome=normalizeOutcome(input.result);
    if(outcome.status==='AMBIGUOUS'){
      throw new DeliveryExecutorError('RECONCILIATION_INCONCLUSIVE',409);
    }
    if(outcome.status==='CONFIRMED'){
      return attemptStore.markConfirmed({
        attemptId:current.id,
        providerMessageId:outcome.providerMessageId,
      });
    }
    return attemptStore.markFailed({attemptId:current.id,reasonCode:outcome.reasonCode});
  }

  return Object.freeze({execute,reconcile});
}

module.exports={createDeliveryExecutor,DeliveryExecutorError};
