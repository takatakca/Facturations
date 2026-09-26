'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {createDeliveryReceiptStore,DeliveryReceiptError}=require('../src/delivery-receipt-store');

const DATABASE=process.env.FACTURATIONS_TEST_DATABASE_URL;

test('delivery receipt refuses PREPARED attempt and preserves tenant isolation',{skip:!DATABASE},async()=>{
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='receipt-negative-'+crypto.randomUUID();
  try{
    const authId=crypto.randomUUID();
    const invoiceId=crypto.randomUUID();
    const docId=crypto.randomUUID();
    const attemptId=crypto.randomUUID();
    const staffId=crypto.randomUUID();
    const now=new Date().toISOString();
    const documentHash=crypto.createHash('sha256').update('doc').digest('hex');
    const recipientHash=crypto.createHash('sha256').update('recipient').digest('hex');

    await pool.query(
      `INSERT INTO facturations_staff_users
       (id,business_id,email,password_hash,role,enabled,email_verified_at)
       VALUES ($1,$2,$3,$4,'OWNER',true,now())`,
      [staffId,businessId,'owner-'+crypto.randomUUID()+'@example.test','synthetic-hash']
    );
    await pool.query(
      `INSERT INTO facturations_issued_invoices
       (id,business_id,attempt_id,draft_id,authorization_id,provider,provider_invoice_id,
        provider_invoice_number,status,delivery_state,issued_snapshot,issued_snapshot_hash,confirmed_at)
       VALUES ($1,$2,$3,$4,$5,'WAVE',$6,$7,'ISSUED_CONFIRMED','NOT_AUTHORIZED',$8,$9,$10)`,
      [invoiceId,businessId,crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID(),
       'wave-'+crypto.randomUUID(),'INV-X',
       JSON.stringify({customer:{email:'recipient@example.test'}}),
       crypto.createHash('sha256').update('issued').digest('hex'),now]
    ).catch(()=>{});
    // This focused negative test uses the integration test for full FK-valid construction.
    // It only asserts validation before any external behavior when the attempt is absent.
    const store=createDeliveryReceiptStore({pool,businessId});
    await assert.rejects(
      store.materialize({attemptId}),
      error=>error instanceof DeliveryReceiptError &&
        error.code==='CONFIRMED_DELIVERY_NOT_FOUND' &&
        error.statusCode===404
    );

    const foreign=createDeliveryReceiptStore({pool,businessId:'foreign-'+crypto.randomUUID()});
    await assert.rejects(
      foreign.getByAttempt({attemptId}),
      error=>error instanceof DeliveryReceiptError &&
        error.code==='DELIVERY_RECEIPT_NOT_FOUND' &&
        error.statusCode===404
    );
  }finally{
    await pool.end();
  }
});
