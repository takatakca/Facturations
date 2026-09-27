'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  SOURCE_DB,
  RESTORE_DB,
  validateTestDatabaseUrl,
  restoredDatabaseUrl,
  adminDatabaseUrl,
}=require('../scripts/backup-restore-drill');

test('backup drill accepts only the exact disposable localhost database',()=>{
  const raw='postgresql://postgres:test-only@127.0.0.1:5432/facturations_test';
  const target=validateTestDatabaseUrl(raw);
  assert.equal(target.host,'127.0.0.1');
  assert.equal(target.port,'5432');
  assert.equal(target.username,'postgres');
  assert.equal(target.password,'test-only');
  assert.equal(new URL(restoredDatabaseUrl(raw)).pathname,'/'+RESTORE_DB);
  assert.equal(new URL(adminDatabaseUrl(raw)).pathname,'/postgres');
  assert.equal(SOURCE_DB,'facturations_test');

  for(const invalid of [
    '',
    'not-a-url',
    'postgresql://postgres:test-only@example.test:5432/facturations_test',
    'postgresql://postgres:test-only@127.0.0.1:5432/production',
    'postgresql://postgres:test-only@127.0.0.1:5433/facturations_test',
    'postgresql://127.0.0.1:5432/facturations_test',
    'https://postgres:test-only@127.0.0.1:5432/facturations_test',
  ]){
    assert.throws(()=>validateTestDatabaseUrl(invalid));
  }
});
