'use strict';

const crypto=require('node:crypto');
const {Pool}=require('pg');
const {
  guardedUrl,CUSTOMER_ID,DRAFT_ID,BUSINESS_ID,EMAIL,REQUEST_HASH,
}=require('./seed-backup-drill');

const REQUIRED_RELATIONS=Object.freeze([
  'invoice_customers',
  'invoice_drafts',
  'invoice_audit_events',
  'facturations_issued_invoices',
  'facturations_issued_invoice_documents',
  'facturations_delivery_receipts',
  'facturations_email_provider_evidence',
  'facturations_payment_evidence',
  'facturations_client_portal_identities',
  'facturations_client_portal_publications',
]);
const REQUIRED_VIEWS=Object.freeze([
  'facturations_email_provider_evidence_summary',
  'facturations_payment_evidence_summary',
]);
const REQUIRED_TRIGGERS=Object.freeze([
  'facturations_issued_invoices_append_only',
  'facturations_issued_invoice_documents_append_only',
  'facturations_delivery_receipts_append_only',
  'facturations_client_portal_publications_append_only',
]);

async function main(){
  if(process.env.FACTURATIONS_DATABASE_URL){
    throw new Error('Refusing restore verification while FACTURATIONS_DATABASE_URL is defined');
  }
  const connectionString=guardedUrl(
    process.env.FACTURATIONS_RESTORE_TEST_DATABASE_URL,
    'facturations_restore_test'
  );
  const pool=new Pool({connectionString});
  try{
    const customer=await pool.query(
      `SELECT id,business_id,name,email,email_normalized,address
         FROM invoice_customers WHERE business_id=$1 AND id=$2`,
      [BUSINESS_ID,CUSTOMER_ID]
    );
    if(customer.rows.length!==1 ||
       customer.rows[0].email!==EMAIL ||
       customer.rows[0].email_normalized!==EMAIL ||
       customer.rows[0].name!=='Backup Drill Customer'){
      throw new Error('Restored customer evidence mismatch');
    }

    const draft=await pool.query(
      `SELECT id,customer_id,request_hash,status,snapshot
         FROM invoice_drafts WHERE business_id=$1 AND id=$2`,
      [BUSINESS_ID,DRAFT_ID]
    );
    if(draft.rows.length!==1 ||
       draft.rows[0].customer_id!==CUSTOMER_ID ||
       draft.rows[0].request_hash!==REQUEST_HASH ||
       draft.rows[0].status!=='DRAFT' ||
       draft.rows[0].snapshot?.marker!=='BACKUP_RESTORE_DRILL_ONLY' ||
       draft.rows[0].snapshot?.totalCents!==12345){
      throw new Error('Restored draft evidence mismatch');
    }

    const audit=await pool.query(
      `SELECT count(*)::integer AS n
         FROM invoice_audit_events
        WHERE business_id=$1 AND draft_id=$2 AND action='DRAFT_CREATED'`,
      [BUSINESS_ID,DRAFT_ID]
    );
    if(audit.rows[0]?.n!==1) throw new Error('Restored audit evidence mismatch');

    const relations=await pool.query(
      `SELECT name,to_regclass('public.'||name) AS relation
         FROM unnest($1::text[]) AS name`,
      [REQUIRED_RELATIONS]
    );
    if(relations.rows.some(row=>row.relation===null)){
      throw new Error('Required restored table missing');
    }

    const views=await pool.query(
      `SELECT table_name
         FROM information_schema.views
        WHERE table_schema='public' AND table_name=ANY($1::text[])`,
      [REQUIRED_VIEWS]
    );
    if(views.rows.length!==REQUIRED_VIEWS.length){
      throw new Error('Required restored view missing');
    }

    const triggers=await pool.query(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgname=ANY($1::text[])`,
      [REQUIRED_TRIGGERS]
    );
    if(triggers.rows.length!==REQUIRED_TRIGGERS.length){
      throw new Error('Required immutable trigger missing');
    }

    let duplicateRejected=false;
    try{
      await pool.query(
        `INSERT INTO invoice_customers
         (id,business_id,name,email,email_normalized)
         VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(),BUSINESS_ID,'Duplicate Restore Proof',EMAIL,EMAIL]
      );
    }catch(error){
      duplicateRejected=error?.code==='23505';
    }
    if(!duplicateRejected) throw new Error('Restored unique constraint did not reject duplicate customer');

    let foreignKeyRejected=false;
    try{
      await pool.query(
        'DELETE FROM invoice_customers WHERE business_id=$1 AND id=$2',
        [BUSINESS_ID,CUSTOMER_ID]
      );
    }catch(error){
      foreignKeyRejected=error?.code==='23503';
    }
    if(!foreignKeyRejected) throw new Error('Restored foreign key did not protect referenced customer');

    console.log(
      'PASS: encrypted backup restored synthetic data, critical relations, views, immutable triggers and constraints'
    );
  }finally{
    await pool.end();
  }
}

if(require.main===module){
  main().catch(()=>{
    console.error('FAIL: restored backup verification failed');
    process.exitCode=1;
  });
}

module.exports={REQUIRED_RELATIONS,REQUIRED_VIEWS,REQUIRED_TRIGGERS};
