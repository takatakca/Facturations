'use strict';

const crypto=require('node:crypto');
const {Pool}=require('pg');

const CUSTOMER_ID='11111111-1111-4111-8111-111111111111';
const DRAFT_ID='22222222-2222-4222-8222-222222222222';
const BUSINESS_ID='backup-drill-only';
const EMAIL='restore-proof@example.test';
const REQUEST_HASH=crypto.createHash('sha256').update('facturations-backup-drill-v1').digest('hex');

function guardedUrl(raw,expectedDatabase){
  if(!raw) throw new Error('Disposable database URL required');
  const url=new URL(raw);
  if(!['postgres:','postgresql:'].includes(url.protocol) ||
     !['127.0.0.1','localhost'].includes(url.hostname) ||
     url.pathname!=='/'+expectedDatabase){
    throw new Error('Refusing backup drill outside disposable localhost database');
  }
  return raw;
}

async function main(){
  if(process.env.FACTURATIONS_DATABASE_URL){
    throw new Error('Refusing backup drill while FACTURATIONS_DATABASE_URL is defined');
  }
  const connectionString=guardedUrl(process.env.FACTURATIONS_TEST_DATABASE_URL,'facturations_test');
  const pool=new Pool({connectionString});
  try{
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO invoice_customers
       (id,business_id,name,email,email_normalized,address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [CUSTOMER_ID,BUSINESS_ID,'Backup Drill Customer',EMAIL,EMAIL,'Synthetic restore evidence only']
    );
    await pool.query(
      `INSERT INTO invoice_drafts
       (id,business_id,customer_id,idempotency_key,request_hash,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [DRAFT_ID,BUSINESS_ID,CUSTOMER_ID,'backup_drill_idempotency_001',REQUEST_HASH,
       JSON.stringify({marker:'BACKUP_RESTORE_DRILL_ONLY',currency:'CAD',totalCents:12345})]
    );
    await pool.query(
      `INSERT INTO invoice_audit_events (business_id,draft_id,action)
       VALUES ($1,$2,'DRAFT_CREATED')`,
      [BUSINESS_ID,DRAFT_ID]
    );
    await pool.query('COMMIT');
    console.log('PASS: synthetic backup drill fixture inserted');
  }catch(error){
    try{await pool.query('ROLLBACK');}catch{}
    throw error;
  }finally{
    await pool.end();
  }
}

if(require.main===module){
  main().catch(()=>{
    console.error('FAIL: synthetic backup drill fixture could not be created');
    process.exitCode=1;
  });
}

module.exports={guardedUrl,CUSTOMER_ID,DRAFT_ID,BUSINESS_ID,EMAIL,REQUEST_HASH};
