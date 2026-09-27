'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {
  createClientPortalAuthStore,
  ClientPortalAuthError,
}=require('../src/client-portal-auth-store');

const DATABASE=process.env.FACTURATIONS_TEST_DATABASE_URL;

test('client portal auth links are owner-issued, one-time, tenant-scoped and email-bound',{
  skip:!DATABASE,
},async()=>{
  const url=new URL(DATABASE);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.pathname,'/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL,undefined);

  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='client-auth-'+crypto.randomUUID();
  const password='synthetic-client-owner-password-2026!';
  try{
    const staffAuth=createStaffAuthStore({pool,businessId});
    const invitations=createStaffInvitationStore({pool,businessId});
    const drafts=createDraftStore({pool,businessId});
    const portal=createClientPortalAuthStore({pool,businessId});

    const owner=await staffAuth.createPendingStaff({
      email:'client-owner-'+crypto.randomUUID()+'@example.test',
      password,
      role:'OWNER',
    });
    const invitation=await invitations.issueInvitation({staffId:owner.id});
    await invitations.redeemInvitation({token:invitation.token,password});
    const ownerSession=await staffAuth.authenticate({email:owner.email,password});

    const customerEmail='portal-client-'+crypto.randomUUID()+'@example.test';
    await drafts.createDraft({
      currency:'CAD',
      customer:{name:'Synthetic Portal Client',email:customerEmail,address:'123 Example Street'},
      invoiceDate:'2026-09-26',
      dueDate:'2026-10-26',
      notes:'Synthetic client auth fixture',
      lines:[{description:'Synthetic service',quantity:1,unitPriceCents:2500,discountCents:0,taxable:false}],
      taxes:[],
    },'clientauth_'+crypto.randomBytes(16).toString('hex'));

    const customerLookup=await pool.query(
      'SELECT id FROM invoice_customers WHERE business_id=$1 AND email_normalized=$2',
      [businessId,customerEmail.toLowerCase()]
    );
    const customerId=customerLookup.rows[0].id;

    const first=await portal.issueAccessLink({
      customerId,
      ownerId:owner.id,
      sessionToken:ownerSession.token,
    });
    assert.equal(first.customerId,customerId);
    assert.equal(first.email,customerEmail.toLowerCase());
    assert.equal(first.purpose,'SIGN_IN_OR_RECOVERY');
    assert.match(first.token,/^[A-Za-z0-9_-]{43}$/);

    const second=await portal.issueAccessLink({
      customerId,
      ownerId:owner.id,
      sessionToken:ownerSession.token,
    });
    assert.notEqual(second.token,first.token);

    await assert.rejects(
      portal.redeemAccessLink({token:first.token}),
      error=>error instanceof ClientPortalAuthError &&
        error.code==='INVALID_CLIENT_ACCESS_LINK' &&
        error.statusCode===401
    );

    const redeemed=await portal.redeemAccessLink({token:second.token});
    assert.equal(redeemed.customer.id,customerId);
    assert.equal(redeemed.customer.email,customerEmail.toLowerCase());
    assert.equal(redeemed.customer.businessId,businessId);
    assert.match(redeemed.token,/^[A-Za-z0-9_-]{43}$/);

    await assert.rejects(
      portal.redeemAccessLink({token:second.token}),
      error=>error instanceof ClientPortalAuthError &&
        error.code==='INVALID_CLIENT_ACCESS_LINK' &&
        error.statusCode===401
    );

    const session=await portal.getSession(redeemed.token);
    assert.deepEqual(session,{
      customerId,
      email:customerEmail.toLowerCase(),
      businessId,
    });

    const foreign=createClientPortalAuthStore({
      pool,
      businessId:'client-auth-other-'+crypto.randomUUID(),
    });
    assert.equal(await foreign.getSession(redeemed.token),null);

    const changedEmail='changed-'+crypto.randomUUID()+'@example.test';
    await pool.query(
      `UPDATE invoice_customers
          SET email=$3,email_normalized=$3,contact_revision=contact_revision+1
        WHERE business_id=$1 AND id=$2`,
      [businessId,customerId,changedEmail]
    );
    assert.equal(await portal.getSession(redeemed.token),null);

    const refreshed=await portal.issueAccessLink({
      customerId,
      ownerId:owner.id,
      sessionToken:ownerSession.token,
    });
    assert.equal(refreshed.email,changedEmail);
    const refreshedSession=await portal.redeemAccessLink({token:refreshed.token});
    assert.equal(refreshedSession.customer.email,changedEmail);

    assert.equal(await portal.revokeSession(refreshedSession.token),true);
    assert.equal(await portal.getSession(refreshedSession.token),null);
    assert.equal(await portal.revokeSession(refreshedSession.token),false);

    const third=await portal.issueAccessLink({
      customerId,
      ownerId:owner.id,
      sessionToken:ownerSession.token,
    });
    const thirdSession=await portal.redeemAccessLink({token:third.token});
    assert.ok(await portal.getSession(thirdSession.token));
    assert.equal(await portal.revokeAllSessionsForCustomer(customerId),1);
    assert.equal(await portal.getSession(thirdSession.token),null);

    const raw=await pool.query(
      `SELECT token_hash FROM facturations_client_access_links
        WHERE business_id=$1 AND customer_id=$2`,
      [businessId,customerId]
    );
    assert.ok(raw.rows.length>=3);
    for(const row of raw.rows){
      assert.ok(Buffer.isBuffer(row.token_hash));
      assert.equal(row.token_hash.length,32);
    }
  }finally{
    await pool.end();
  }
});
