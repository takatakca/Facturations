'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const {
  MigrationIntegrityError,
  gitBlobSha1,
  verifyMigrationIntegrity,
}=require('../scripts/verify-migration-integrity');

const ROOT=path.join(__dirname,'..');
const DB=path.join(ROOT,'db');
const LOCK=path.join(DB,'migration-integrity-lock.json');

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'facturations-migrations-'));
  const db=path.join(root,'db');
  fs.mkdirSync(db);
  const lock=JSON.parse(fs.readFileSync(LOCK,'utf8'));
  for(const item of lock.migrations){
    fs.copyFileSync(path.join(DB,item.file),path.join(db,item.file));
  }
  const lockPath=path.join(db,'migration-integrity-lock.json');
  fs.writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n');
  return {root,db,lockPath,lock};
}

test('repository migrations match the immutable integrity lock',()=>{
  const result=verifyMigrationIntegrity();
  assert.equal(result.lockedThrough,28);
  assert.equal(result.migrationCount,28);
  assert.match(result.proofSha256,/^[a-f0-9]{64}$/);
});

test('Git blob hash uses exact byte length and content',()=>{
  const content=Buffer.from('hello\n','utf8');
  assert.equal(gitBlobSha1(content),'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('editing a locked historical migration fails closed',()=>{
  const f=fixture();
  try{
    fs.appendFileSync(path.join(f.db,f.lock.migrations[0].file),'-- drift\n');
    assert.throws(
      ()=>verifyMigrationIntegrity({dbDir:f.db,lockPath:f.lockPath}),
      error=>error instanceof MigrationIntegrityError &&
        error.code==='MIGRATION_CONTENT_DRIFT'
    );
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('adding an unregistered migration fails closed',()=>{
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.db,'028_unreviewed.sql'),'SELECT 1;\n');
    assert.throws(
      ()=>verifyMigrationIntegrity({dbDir:f.db,lockPath:f.lockPath}),
      error=>error instanceof MigrationIntegrityError &&
        error.code==='MIGRATION_SET_DRIFT'
    );
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('removing or corrupting lock metadata fails closed',()=>{
  const f=fixture();
  try{
    const broken={...f.lock,lockedThrough:25};
    fs.writeFileSync(f.lockPath,JSON.stringify(broken));
    assert.throws(
      ()=>verifyMigrationIntegrity({dbDir:f.db,lockPath:f.lockPath}),
      error=>error instanceof MigrationIntegrityError &&
        error.code==='MIGRATION_LOCK_INVALID'
    );
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
