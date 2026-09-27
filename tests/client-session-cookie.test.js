'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  createClientSessionCookie,
  clearClientSessionCookie,
  readClientSessionCookie,
}=require('../src/client-session-cookie');

const TOKEN='A'.repeat(43);

test('client portal cookie is host-only secure httpOnly and readable only once',()=>{
  const header=createClientSessionCookie(TOKEN);
  assert.match(header,/^__Host-facturations_client_session=/);
  assert.match(header,/Path=\//);
  assert.match(header,/HttpOnly/);
  assert.match(header,/Secure/);
  assert.match(header,/SameSite=Lax/);
  assert.equal(readClientSessionCookie(header),TOKEN);
  assert.equal(readClientSessionCookie('__Host-facturations_client_session=bad'),null);
  assert.equal(readClientSessionCookie(
    '__Host-facturations_client_session='+TOKEN+'; __Host-facturations_client_session='+TOKEN
  ),null);
  assert.match(clearClientSessionCookie(),/Max-Age=0/);
});
