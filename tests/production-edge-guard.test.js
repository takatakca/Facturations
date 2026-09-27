'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');

const {
  attachProductionEdgeGuard,
  STRICT_TRANSPORT_SECURITY,
}=require('../src/production-edge-guard');

function request(port,{host='facturations.example.test',proto='https'}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({
      host:'127.0.0.1',
      port,
      path:'/health',
      headers:{
        Host:host,
        'X-Forwarded-Proto':proto,
      },
    },res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({
        status:res.statusCode,
        headers:res.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error',reject);
    req.end();
  });
}

test('edge guard adds HSTS and preserves existing request listeners',async()=>{
  const calls=[];
  const server=http.createServer((req,res)=>{
    calls.push('main');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end('{"ok":true}');
  });
  server.prependListener('request',()=>calls.push('prepended'));
  attachProductionEdgeGuard(server,{
    origin:'https://facturations.example.test',
    enforceProxy:true,
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await request(server.address().port);
    assert.equal(response.status,200);
    assert.equal(response.headers['strict-transport-security'],STRICT_TRANSPORT_SECURITY);
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.equal(response.headers['referrer-policy'],'no-referrer');
    assert.deepEqual(calls,['prepended','main']);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('edge guard rejects wrong host or missing HTTPS proxy evidence before app handlers run',async()=>{
  let calls=0;
  const server=http.createServer((_req,res)=>{
    calls+=1;
    res.writeHead(200);
    res.end('should not run');
  });
  attachProductionEdgeGuard(server,{
    origin:'https://facturations.example.test',
    enforceProxy:true,
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const options of [
      {host:'evil.example.test',proto:'https'},
      {host:'facturations.example.test',proto:'http'},
      {host:'facturations.example.test',proto:''},
    ]){
      const response=await request(server.address().port,options);
      assert.equal(response.status,421);
      assert.deepEqual(JSON.parse(response.body),{error:'SECURE_PROXY_REQUIRED'});
      assert.equal(response.headers['strict-transport-security'],STRICT_TRANSPORT_SECURITY);
    }
    assert.equal(calls,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('non-enforcing guard still adds HSTS for HTTPS-configured staging without trusting proxy headers',async()=>{
  const server=http.createServer((_req,res)=>{
    res.writeHead(200);
    res.end('ok');
  });
  attachProductionEdgeGuard(server,{
    origin:'https://facturations.example.test',
    enforceProxy:false,
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await request(server.address().port,{host:'anything.invalid',proto:'http'});
    assert.equal(response.status,200);
    assert.equal(response.headers['strict-transport-security'],STRICT_TRANSPORT_SECURITY);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});
