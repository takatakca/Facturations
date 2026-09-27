'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createReadinessProbe}=require('../src/readiness-probe');

test('readiness probe verifies PostgreSQL and fails closed while draining',async()=>{
  let calls=0;
  const pool={
    async query(sql){
      calls+=1;
      assert.equal(sql,'SELECT 1 AS ok');
      return {rows:[{ok:1}]};
    },
  };
  const probe=createReadinessProbe({pool});
  assert.equal(await probe.check(),true);
  assert.equal(calls,1);
  probe.markDraining();
  assert.equal(await probe.check(),false);
  assert.equal(calls,1,'draining readiness must not query PostgreSQL');
});

test('readiness probe hides PostgreSQL failures',async()=>{
  const probe=createReadinessProbe({
    pool:{async query(){throw new Error('synthetic connection string detail');}},
  });
  assert.equal(await probe.check(),false);
});

test('readiness probe requires a PostgreSQL-like pool',()=>{
  assert.throws(()=>createReadinessProbe(),/PostgreSQL pool/);
});
