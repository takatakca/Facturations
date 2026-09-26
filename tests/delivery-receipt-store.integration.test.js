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
    const attemptId=crypto.randomUUID();
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
