'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ROOT=path.join(__dirname,'..','.github','workflows');
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^postgres:16@sha256:[a-f0-9]{64}$/u;

function workflowFiles(){
  return fs.readdirSync(ROOT)
    .filter(name=>/\.ya?ml$/u.test(name))
    .sort()
    .map(name=>path.join(ROOT,name));
}

test('all third-party GitHub Actions are pinned to immutable commit SHAs',()=>{
  const refs=[];
  for(const file of workflowFiles()){
    const content=fs.readFileSync(file,'utf8');
    for(const match of content.matchAll(/\buses:\s*([^\s#]+)/gu)){
      const ref=match[1];
      if(ref.startsWith('./')) continue;
      refs.push({file:path.basename(file),ref});
      const at=ref.lastIndexOf('@');
      assert.ok(at>0,ref+' must include an immutable revision');
      assert.match(ref.slice(at+1),SHA,ref+' must be pinned to a 40-hex commit SHA');
    }
  }
  assert.ok(refs.length>=6,'expected checkout/setup-node pins in all workflows');
});

test('PostgreSQL service images are digest-pinned and Node matrix never fail-fast cancels evidence',()=>{
  for(const name of ['ci.yml','browser-mfa-postgres.yml']){
    const content=fs.readFileSync(path.join(ROOT,name),'utf8');
    const image=/\bimage:\s*([^\s#]+)/u.exec(content)?.[1];
    assert.match(image||'',DIGEST,name+' must pin PostgreSQL 16 by digest');
  }

  const ci=fs.readFileSync(path.join(ROOT,'ci.yml'),'utf8');
  assert.match(ci,/strategy:\s*\n\s*fail-fast:\s*false\b/u);
  assert.match(ci,/node:\s*\['20',\s*'22'\]/u);
});

test('checkout never persists GitHub credentials in the working tree',()=>{
  for(const file of workflowFiles()){
    const content=fs.readFileSync(file,'utf8');
    const checkoutCount=[...content.matchAll(/actions\/checkout@[a-f0-9]{40}/gu)].length;
    const disabledCount=[...content.matchAll(/persist-credentials:\s*false/gu)].length;
    assert.equal(disabledCount,checkoutCount,path.basename(file)+' must disable persisted checkout credentials');
  }
});


test('workflow runner generation is explicit rather than ubuntu-latest',()=>{
  for(const file of workflowFiles()){
    const content=fs.readFileSync(file,'utf8');
    assert.equal(content.includes('ubuntu-latest'),false,path.basename(file)+' must not use ubuntu-latest');
    assert.match(content,/runs-on:\s*ubuntu-24\.04\b/u);
  }
});
