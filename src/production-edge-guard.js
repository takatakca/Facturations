'use strict';

const STRICT_TRANSPORT_SECURITY='max-age=31536000';

function attachProductionEdgeGuard(server,{origin,enforceProxy=false}={}){
  if(!server || typeof server.listeners!=='function' || typeof server.removeAllListeners!=='function' ||
     typeof server.on!=='function'){
    throw new TypeError('HTTP server required');
  }
  if(typeof origin!=='string' || !/^https:\/\//u.test(origin) || new URL(origin).origin!==origin){
    throw new TypeError('Exact HTTPS origin required');
  }
  if(typeof enforceProxy!=='boolean') throw new TypeError('enforceProxy must be boolean');

  const listeners=server.listeners('request');
  if(listeners.length<1) throw new TypeError('Request handler required');
  const expectedHost=new URL(origin).host;
  server.removeAllListeners('request');

  server.on('request',(request,response)=>{
    if(!response.headersSent){
      response.setHeader('Strict-Transport-Security',STRICT_TRANSPORT_SECURITY);
      response.setHeader('X-Content-Type-Options','nosniff');
      response.setHeader('Referrer-Policy','no-referrer');
    }

    if(enforceProxy){
      const forwardedProto=request.headers['x-forwarded-proto'];
      if(request.headers.host!==expectedHost || forwardedProto!=='https'){
        if(!response.headersSent && !response.destroyed){
          response.writeHead(421,{
            'Content-Type':'application/json; charset=utf-8',
            'Cache-Control':'no-store',
            'Strict-Transport-Security':STRICT_TRANSPORT_SECURITY,
            'X-Content-Type-Options':'nosniff',
            'Referrer-Policy':'no-referrer',
          });
          response.end(JSON.stringify({error:'SECURE_PROXY_REQUIRED'}));
        }
        return;
      }
    }

    for(const listener of listeners){
      listener.call(server,request,response);
    }
  });
  return server;
}

module.exports={attachProductionEdgeGuard,STRICT_TRANSPORT_SECURITY};
