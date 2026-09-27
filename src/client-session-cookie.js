'use strict';

const NAME='__Host-facturations_client_session';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;

function createClientSessionCookie(token){
  if(typeof token!=='string' || !TOKEN.test(token)) throw new TypeError('Valid client session token required');
  return NAME+'='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200';
}
function clearClientSessionCookie(){
  return NAME+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
function readClientSessionCookie(header){
  if(typeof header!=='string' || !header) return null;
  const parts=header.split(';');
  let found=null;
  for(const part of parts){
    const index=part.indexOf('=');
    if(index<0) continue;
    const name=part.slice(0,index).trim();
    if(name!==NAME) continue;
    if(found!==null) return null;
    const value=part.slice(index+1).trim();
    if(!TOKEN.test(value)) return null;
    found=value;
  }
  return found;
}

module.exports={createClientSessionCookie,clearClientSessionCookie,readClientSessionCookie};
