'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const ROOT=path.join(__dirname,'..');
const DB=path.join(ROOT,'db');
const LOCK=path.join(DB,'migration-integrity-lock.json');

class MigrationIntegrityError extends Error {
  constructor(code){
    super(code);
    this.name='MigrationIntegrityError';
    this.code=code;
  }
}

function gitBlobSha1(buffer){
  if(!Buffer.isBuffer(buffer)) throw new TypeError('Migration content buffer required');
  return crypto.createHash('sha1')
    .update('blob '+buffer.length+'\0','utf8')
    .update(buffer)
    .digest('hex');
}

function loadLock(lockPath=LOCK){
  let lock;
  try{lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));}
  catch{throw new MigrationIntegrityError('MIGRATION_LOCK_INVALID');}
  if(!lock || typeof lock!=='object' || Array.isArray(lock) ||
     Object.keys(lock).sort().join(',')!=='algorithm,lockedThrough,migrations,version' ||
     lock.version!==1 || lock.algorithm!=='git-blob-sha1' ||
     !Number.isInteger(lock.lockedThrough) || lock.lockedThrough<1 ||
     !Array.isArray(lock.migrations) || lock.migrations.length!==lock.lockedThrough){
    throw new MigrationIntegrityError('MIGRATION_LOCK_INVALID');
  }
  return lock;
}

function expectedFilename(number,file){
  const prefix=String(number).padStart(3,'0')+'_';
  return typeof file==='string' && file.startsWith(prefix) && /^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(file);
}

function verifyMigrationIntegrity({dbDir=DB,lockPath=LOCK}={}){
  const lock=loadLock(lockPath);
  const disk=fs.readdirSync(dbDir)
    .filter(name=>/^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();

  const expected=lock.migrations.map(item=>item.file);
  if(JSON.stringify(disk)!==JSON.stringify(expected)){
    throw new MigrationIntegrityError('MIGRATION_SET_DRIFT');
  }

  const proof=[];
  for(let index=0;index<lock.migrations.length;index+=1){
    const sequence=index+1;
    const item=lock.migrations[index];
    if(!item || typeof item!=='object' || Array.isArray(item) ||
       Object.keys(item).sort().join(',')!=='bytes,file,gitBlobSha1' ||
       !expectedFilename(sequence,item.file) ||
       typeof item.gitBlobSha1!=='string' || !/^[a-f0-9]{40}$/u.test(item.gitBlobSha1) ||
       !Number.isInteger(item.bytes) || item.bytes<1){
      throw new MigrationIntegrityError('MIGRATION_LOCK_INVALID');
    }

    const content=fs.readFileSync(path.join(dbDir,item.file));
    const actualSha=gitBlobSha1(content);
    if(content.length!==item.bytes || actualSha!==item.gitBlobSha1){
      throw new MigrationIntegrityError('MIGRATION_CONTENT_DRIFT');
    }
    proof.push(item.file+'\0'+item.gitBlobSha1+'\0'+item.bytes);
  }

  const proofSha256=crypto.createHash('sha256').update(proof.join('\n')).digest('hex');
  return Object.freeze({
    lockedThrough:lock.lockedThrough,
    migrationCount:lock.migrations.length,
    proofSha256,
  });
}

if(require.main===module){
  try{
    const result=verifyMigrationIntegrity();
    console.info(
      'PASS: migration integrity lock verified 001-'+
      String(result.lockedThrough).padStart(3,'0')+
      '; proof SHA-256 '+result.proofSha256
    );
  }catch{
    console.error('FAIL: migration integrity lock mismatch');
    process.exitCode=1;
  }
}

module.exports={MigrationIntegrityError,gitBlobSha1,loadLock,verifyMigrationIntegrity};
