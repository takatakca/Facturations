'use strict';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{16,80}$/;
const HASH=/^[a-f0-9]{64}$/;
const ERROR=/^[A-Z0-9_:-]{1,100}$/;
const ACTIVE=new Set(['PREPARED','IN_FLIGHT','AMBIGUOUS']);
const RETRYABLE_PREVIOUS=new Set(['FAILED_RETRYABLE','RECONCILED_NOT_FOUND']);
const OUTCOMES=new Set(['CONFIRMED','AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL']);

class ProviderAttemptError extends Error{
  constructor(code,statusCode=422){
    super(code);this.name='ProviderAttemptError';this.code=code;this.statusCode=statusCode;
  }
}
function uuid(value,code='INVALID_ATTEMPT_ID'){
  if(typeof value!=='string'||!UUID.test(value)) throw new ProviderAttemptError(code);
  return value;
}
function providerText(value,max,code){
  if(typeof value!=='string'||value.length<1||value.length>max||/[\u0000-\u001f\u007f]/u.test(value)){
    throw new ProviderAttemptError(code);
  }
  return value;
}
function asResult(row){
  return Object.freeze({
    id:row.id,
    draftId:row.draft_id,
    authorizationId:row.authorization_id,
    provider:row.provider,
    operation:row.operation,
    idempotencyKey:row.idempotency_key,
    requestHash:row.request_hash,
    planHash:row.plan_hash,
    attemptNo:row.attempt_no,
    parentAttemptId:row.parent_attempt_id,
    state:row.state,
    providerInvoiceId:row.provider_invoice_id,
    providerInvoiceNumber:row.provider_invoice_number,
    errorCode:row.error_code,
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,
    updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at,
  });
}
function createProviderAttemptStore({pool,businessId}){
  if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string'||!businessId.trim()||businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function insertEvent(client,attemptId,fromState,toState,eventCode){
    await client.query(
      `INSERT INTO facturations_provider_attempt_events
       (business_id,attempt_id,from_state,to_state,event_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [tenant,attemptId,fromState,toState,eventCode]
    );
  }

  async function prepare(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
       Object.keys(input).sort().join(',')!=='draftId,idempotencyKey,planHash'){
      throw new ProviderAttemptError('INVALID_PREPARE');
    }
    uuid(input.draftId,'INVALID_DRAFT_ID');
    if(typeof input.idempotencyKey!=='string'||!KEY.test(input.idempotencyKey)){
      throw new ProviderAttemptError('INVALID_IDEMPOTENCY_KEY');
    }
    if(typeof input.planHash!=='string'||!HASH.test(input.planHash)){
      throw new ProviderAttemptError('INVALID_PLAN_HASH');
    }
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      const authorized=await client.query(
        `SELECT a.id AS authorization_id,a.request_hash,d.request_hash AS draft_hash
           FROM facturations_issuance_authorizations a
           JOIN invoice_drafts d
             ON d.business_id=a.business_id AND d.id=a.draft_id AND d.status='DRAFT'
          WHERE a.business_id=$1 AND a.draft_id=$2
            AND a.provider='WAVE' AND a.state='AUTHORIZED_PENDING_PROVIDER'
          FOR SHARE OF a,d`,
        [tenant,input.draftId]
      );
      if(!authorized.rows.length) throw new ProviderAttemptError('ISSUANCE_AUTHORIZATION_REQUIRED',409);
      const auth=authorized.rows[0];
      if(auth.request_hash!==auth.draft_hash){
        throw new ProviderAttemptError('AUTHORIZATION_HASH_MISMATCH',409);
      }

      const priorKey=await client.query(
        `SELECT * FROM facturations_provider_attempts
          WHERE business_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [tenant,input.idempotencyKey]
      );
      if(priorKey.rows.length){
        const row=priorKey.rows[0];
        if(row.draft_id!==input.draftId||row.plan_hash!==input.planHash||
           row.request_hash!==auth.request_hash){
          throw new ProviderAttemptError('IDEMPOTENCY_CONFLICT',409);
        }
        await client.query('COMMIT');tx=false;
        return asResult(row);
      }

      const latest=await client.query(
        `SELECT * FROM facturations_provider_attempts
          WHERE business_id=$1 AND draft_id=$2
          ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`,
        [tenant,input.draftId]
      );
      let attemptNo=1,parentAttemptId=null;
      if(latest.rows.length){
        const previous=latest.rows[0];
        if(ACTIVE.has(previous.state)){
          throw new ProviderAttemptError(
            previous.state==='AMBIGUOUS'?'RECONCILIATION_REQUIRED':'ATTEMPT_ACTIVE',409);
        }
        if(previous.state==='CONFIRMED') throw new ProviderAttemptError('ALREADY_CONFIRMED',409);
        if(previous.state==='FAILED_FINAL') throw new ProviderAttemptError('FINAL_FAILURE',409);
        if(!RETRYABLE_PREVIOUS.has(previous.state)){
          throw new ProviderAttemptError('RETRY_NOT_ALLOWED',409);
        }
        if(previous.plan_hash!==input.planHash||previous.request_hash!==auth.request_hash){
          throw new ProviderAttemptError('RETRY_PLAN_CHANGED',409);
        }
        attemptNo=previous.attempt_no+1;
        parentAttemptId=previous.id;
      }

      const inserted=await client.query(
        `INSERT INTO facturations_provider_attempts
         (business_id,draft_id,authorization_id,provider,operation,idempotency_key,
          request_hash,plan_hash,attempt_no,parent_attempt_id,state)
         VALUES ($1,$2,$3,'WAVE','ISSUE_INVOICE',$4,$5,$6,$7,$8,'PREPARED')
         RETURNING *`,
        [tenant,input.draftId,auth.authorization_id,input.idempotencyKey,
          auth.request_hash,input.planHash,attemptNo,parentAttemptId]
      );
      const row=inserted.rows[0];
      await insertEvent(client,row.id,null,'PREPARED','ATTEMPT_PREPARED');
      await client.query('COMMIT');tx=false;
      return asResult(row);
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      if(error?.code==='23505') throw new ProviderAttemptError('CONCURRENT_ATTEMPT',409);
      throw error;
    }finally{client.release();}
  }

  async function start(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
       Object.keys(input).sort().join(',')!=='attemptId'){
      throw new ProviderAttemptError('INVALID_START');
    }
    const attemptId=uuid(input.attemptId);
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      const found=await client.query(
        'SELECT * FROM facturations_provider_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE',
        [tenant,attemptId]
      );
      if(!found.rows.length) throw new ProviderAttemptError('ATTEMPT_NOT_FOUND',404);
      let row=found.rows[0];
      if(row.state==='IN_FLIGHT'){
        await client.query('COMMIT');tx=false;return asResult(row);
      }
      if(row.state!=='PREPARED') throw new ProviderAttemptError('START_NOT_ALLOWED',409);
      const updated=await client.query(
        `UPDATE facturations_provider_attempts
            SET state='IN_FLIGHT'
          WHERE business_id=$1 AND id=$2 RETURNING *`,
        [tenant,attemptId]
      );
      row=updated.rows[0];
      await insertEvent(client,attemptId,'PREPARED','IN_FLIGHT','ATTEMPT_STARTED');
      await client.query('COMMIT');tx=false;
      return asResult(row);
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function recordOutcome(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
       Object.keys(input).sort().join(',')!==
         'attemptId,errorCode,outcome,providerInvoiceId,providerInvoiceNumber'){
      throw new ProviderAttemptError('INVALID_OUTCOME');
    }
    const attemptId=uuid(input.attemptId);
    if(!OUTCOMES.has(input.outcome)) throw new ProviderAttemptError('INVALID_OUTCOME');
    let providerInvoiceId=null,providerInvoiceNumber=null,errorCode=null;
    if(input.outcome==='CONFIRMED'){
      providerInvoiceId=providerText(input.providerInvoiceId,512,'PROVIDER_INVOICE_ID_REQUIRED');
      providerInvoiceNumber=providerText(input.providerInvoiceNumber,200,'PROVIDER_INVOICE_NUMBER_REQUIRED');
      if(input.errorCode!==null) throw new ProviderAttemptError('INVALID_CONFIRMED_OUTCOME');
    }else{
      if(input.providerInvoiceId!==null||input.providerInvoiceNumber!==null){
        throw new ProviderAttemptError('UNCONFIRMED_PROVIDER_ID_FORBIDDEN');
      }
      if(typeof input.errorCode!=='string'||!ERROR.test(input.errorCode)){
        throw new ProviderAttemptError('ERROR_CODE_REQUIRED');
      }
      errorCode=input.errorCode;
    }
    const event={
      CONFIRMED:'PROVIDER_CONFIRMED',
      AMBIGUOUS:'PROVIDER_AMBIGUOUS',
      FAILED_RETRYABLE:'PROVIDER_FAILED_RETRYABLE',
      FAILED_FINAL:'PROVIDER_FAILED_FINAL',
    }[input.outcome];
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      const found=await client.query(
        'SELECT * FROM facturations_provider_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE',
        [tenant,attemptId]
      );
      if(!found.rows.length) throw new ProviderAttemptError('ATTEMPT_NOT_FOUND',404);
      let row=found.rows[0];
      if(row.state===input.outcome){
        const same=row.provider_invoice_id===providerInvoiceId&&
          row.provider_invoice_number===providerInvoiceNumber&&row.error_code===errorCode;
        if(!same) throw new ProviderAttemptError('OUTCOME_CONFLICT',409);
        await client.query('COMMIT');tx=false;return asResult(row);
      }
      if(row.state!=='IN_FLIGHT') throw new ProviderAttemptError('OUTCOME_NOT_ALLOWED',409);
      const updated=await client.query(
        `UPDATE facturations_provider_attempts
            SET state=$3,provider_invoice_id=$4,provider_invoice_number=$5,error_code=$6
          WHERE business_id=$1 AND id=$2 RETURNING *`,
        [tenant,attemptId,input.outcome,providerInvoiceId,providerInvoiceNumber,errorCode]
      );
      row=updated.rows[0];
      await insertEvent(client,attemptId,'IN_FLIGHT',input.outcome,event);
      await client.query('COMMIT');tx=false;
      return asResult(row);
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function reconcile(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||
       Object.keys(input).sort().join(',')!==
         'attemptId,providerInvoiceId,providerInvoiceNumber,result'){
      throw new ProviderAttemptError('INVALID_RECONCILIATION');
    }
    const attemptId=uuid(input.attemptId);
    if(!['FOUND','NOT_FOUND'].includes(input.result)){
      throw new ProviderAttemptError('INVALID_RECONCILIATION');
    }
    let target,event,providerInvoiceId=null,providerInvoiceNumber=null;
    if(input.result==='FOUND'){
      target='CONFIRMED';event='RECONCILIATION_FOUND';
      providerInvoiceId=providerText(input.providerInvoiceId,512,'PROVIDER_INVOICE_ID_REQUIRED');
      providerInvoiceNumber=providerText(input.providerInvoiceNumber,200,'PROVIDER_INVOICE_NUMBER_REQUIRED');
    }else{
      target='RECONCILED_NOT_FOUND';event='RECONCILIATION_NOT_FOUND';
      if(input.providerInvoiceId!==null||input.providerInvoiceNumber!==null){
        throw new ProviderAttemptError('RECONCILIATION_PROVIDER_ID_FORBIDDEN');
      }
    }
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      const found=await client.query(
        'SELECT * FROM facturations_provider_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE',
        [tenant,attemptId]
      );
      if(!found.rows.length) throw new ProviderAttemptError('ATTEMPT_NOT_FOUND',404);
      let row=found.rows[0];
      if(row.state===target){
        const same=row.provider_invoice_id===providerInvoiceId&&
          row.provider_invoice_number===providerInvoiceNumber;
        if(!same) throw new ProviderAttemptError('RECONCILIATION_CONFLICT',409);
        await client.query('COMMIT');tx=false;return asResult(row);
      }
      if(row.state!=='AMBIGUOUS') throw new ProviderAttemptError('RECONCILIATION_NOT_ALLOWED',409);
      const updated=await client.query(
        `UPDATE facturations_provider_attempts
            SET state=$3,provider_invoice_id=$4,provider_invoice_number=$5,error_code=NULL
          WHERE business_id=$1 AND id=$2 RETURNING *`,
        [tenant,attemptId,target,providerInvoiceId,providerInvoiceNumber]
      );
      row=updated.rows[0];
      await insertEvent(client,attemptId,'AMBIGUOUS',target,event);
      await client.query('COMMIT');tx=false;
      return asResult(row);
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function getLatest(draftId){
    uuid(draftId,'INVALID_DRAFT_ID');
    const result=await pool.query(
      `SELECT * FROM facturations_provider_attempts
        WHERE business_id=$1 AND draft_id=$2 ORDER BY attempt_no DESC LIMIT 1`,
      [tenant,draftId]
    );
    return result.rows[0]?asResult(result.rows[0]):null;
  }

  return Object.freeze({prepare,start,recordOutcome,reconcile,getLatest});
}

module.exports={createProviderAttemptStore,ProviderAttemptError};
