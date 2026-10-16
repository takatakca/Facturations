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

test('readiness in-flight PostgreSQL check fails closed once draining starts',async()=>{
  let resolveQuery;
  let calls=0;
  const probe=createReadinessProbe({
    pool:{query(sql){
      assert.equal(sql,'SELECT 1 AS ok');
      calls++;
      return new Promise(resolve=>{resolveQuery=resolve;});
    }},
  });

  const inFlight=probe.check();
  assert.equal(calls,1);
  assert.equal(typeof resolveQuery,'function');

  // Simulate SIGTERM during a successful but delayed database health check.
  probe.markDraining();
  resolveQuery({rows:[{ok:1}]});
  assert.equal(await inFlight,false,'a late DB success must not turn readiness green');
  assert.equal(await probe.check(),false);
  assert.equal(calls,1,'no further DB queries after draining');
});

test('readiness in-flight failures remain false without leaking query errors',async()=>{
  let rejectQuery;
  const probe=createReadinessProbe({
    pool:{query(){
      return new Promise((_resolve,reject)=>{rejectQuery=reject;});
    }},
  });
  const inFlight=probe.check();
  probe.markDraining();
  rejectQuery(new Error('synthetic database credentials must not leak'));
  assert.equal(await inFlight,false);
});
