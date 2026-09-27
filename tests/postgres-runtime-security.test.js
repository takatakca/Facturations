'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const {
  PostgresRuntimeSecurityError,
  databaseTarget,
  evaluateRuntimeRole,
  runPostgresRuntimeSecurityPreflight,
}=require('../src/postgres-runtime-security');

function safeRow(overrides={}){
  return {
    database_name:'facturations_test',
    can_login:true,
    is_superuser:false,
    can_create_role:false,
    can_create_database:false,
    can_replicate:false,
    can_bypass_rls:false,
    database_create:false,
    schema_create:false,
    schema_usage:true,
    connection_ssl:true,
    owned_relations:0,
    owned_functions:0,
    dangerous_memberships:0,
    ...overrides,
  };
}

test('database target returns only database name and loopback classification',()=>{
  const target=databaseTarget('postgresql://runtime:secret@127.0.0.1:5432/facturations_test');
  assert.deepEqual(target,{database:'facturations_test',loopback:true});
  assert.equal(JSON.stringify(target).includes('secret'),false);
  assert.throws(()=>databaseTarget('https://user:secret@example.test/db'));
  assert.throws(()=>databaseTarget('postgresql://user@example.test/'));
});

test('safe least-privilege runtime role is accepted',()=>{
  assert.deepEqual(
    evaluateRuntimeRole(safeRow(),{database:'facturations_test',loopback:false}),
    {ok:true,failures:[],transport:'TLS'}
  );
});

test('every dangerous capability is rejected',()=>{
  const cases=[
    ['is_superuser','ROLE_SUPERUSER_FORBIDDEN'],
    ['can_create_role','ROLE_CREATE_ROLE_FORBIDDEN'],
    ['can_create_database','ROLE_CREATE_DATABASE_FORBIDDEN'],
    ['can_replicate','ROLE_REPLICATION_FORBIDDEN'],
    ['can_bypass_rls','ROLE_BYPASS_RLS_FORBIDDEN'],
    ['database_create','DATABASE_CREATE_FORBIDDEN'],
    ['schema_create','SCHEMA_CREATE_FORBIDDEN'],
  ];
  for(const [field,code] of cases){
    const result=evaluateRuntimeRole(safeRow({[field]:true}),{database:'facturations_test',loopback:false});
    assert.equal(result.ok,false);
    assert.ok(result.failures.includes(code));
  }
  assert.ok(evaluateRuntimeRole(safeRow({owned_relations:1}),{database:'facturations_test',loopback:false})
    .failures.includes('RUNTIME_OBJECT_OWNERSHIP_FORBIDDEN'));
  assert.ok(evaluateRuntimeRole(safeRow({owned_functions:1}),{database:'facturations_test',loopback:false})
    .failures.includes('RUNTIME_OBJECT_OWNERSHIP_FORBIDDEN'));
  assert.ok(evaluateRuntimeRole(safeRow({dangerous_memberships:1}),{database:'facturations_test',loopback:false})
    .failures.includes('DANGEROUS_ROLE_MEMBERSHIP_FORBIDDEN'));
});

test('remote database must use TLS and schema usage is required',()=>{
  const insecure=evaluateRuntimeRole(
    safeRow({connection_ssl:false,schema_usage:false}),
    {database:'facturations_test',loopback:false}
  );
  assert.equal(insecure.ok,false);
  assert.ok(insecure.failures.includes('REMOTE_DATABASE_TLS_REQUIRED'));
  assert.ok(insecure.failures.includes('SCHEMA_USAGE_REQUIRED'));

  const loopback=evaluateRuntimeRole(
    safeRow({connection_ssl:false}),
    {database:'facturations_test',loopback:true}
  );
  assert.equal(loopback.ok,true);
  assert.equal(loopback.transport,'LOOPBACK');
});

test('preflight fails closed and never returns connection details',async()=>{
  let ended=false;
  const fakePool={
    on(){},
    async query(){return {rows:[safeRow({is_superuser:true})]};},
    async end(){ended=true;},
  };
  await assert.rejects(
    runPostgresRuntimeSecurityPreflight({
      databaseUrl:'postgresql://runtime:top-secret@example.test/facturations_test',
      poolFactory:()=>fakePool,
    }),
    error=>error instanceof PostgresRuntimeSecurityError &&
      error.code==='RUNTIME_DATABASE_PRIVILEGES_UNSAFE' &&
      !String(error).includes('top-secret')
  );
  assert.equal(ended,true);
});
