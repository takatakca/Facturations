'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createStaffAuthStore}=require('../src/staff-auth-store');
const {createStaffInvitationStore}=require('../src/staff-invitation-store');
const {createDraftStore}=require('../src/draft-store');
const {createDraftApprovalStore}=require('../src/draft-approval-store');
const {createIssuanceAuthorizationStore}=require('../src/issuance-authorization-store');
const {createWaveMappingStore,WaveMappingError}=require('../src/wave-mapping-store');
const {buildWaveIssuancePreflight}=require('../src/wave-issuance-preflight');

const DATABASE=process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provision({pool,businessId,role='OWNER'}){
  const auth=createStaffAuthStore({pool,businessId});
  const invitations=createStaffInvitationStore({pool,businessId});
  const password='fictional-wave-mapping-password-2026!'+role;
  const member=await auth.createPendingStaff({
    email:role.toLowerCase()+'-'+crypto.randomUUID()+'@example.test',
    password,role,
  });
  const invitation=await invitations.issueInvitation({staffId:member.id});
  await invitations.redeemInvitation({token:invitation.token,password});
  const session=await auth.authenticate({email:member.email,password});
  return {auth,member,session};
}
function payload(email){
  return {
    currency:'CAD',
    customer:{name:'Synthetic Mapping Customer',email,address:'Example only'},
    invoiceDate:'2026-09-23',dueDate:'2026-10-23',notes:'Mapping test only',
    lines:[
      {description:'Synthetic taxable service',quantity:2,unitPriceCents:1000,taxable:true},
      {description:'Synthetic non-taxable service',quantity:1,unitPriceCents:500,taxable:false},
    ],
    taxes:[
      {code:'GST',label:'Synthetic GST',rateMilliPercent:5000},
      {code:'QST',label:'Synthetic QST',rateMilliPercent:9975},
    ],
  };
}
async function makeAuthorized({pool,businessId,owner,session}){
  const drafts=createDraftStore({pool,businessId});
  const approvals=createDraftApprovalStore({pool,businessId});
  const authorizations=createIssuanceAuthorizationStore({pool,businessId});
  const email='customer-'+crypto.randomUUID()+'@example.test';
  const draft=await drafts.createDraft(payload(email),'map_'+crypto.randomBytes(12).toString('hex'));
  await approvals.approveDraft({
    confirmation:'APPROVE_DRAFT_ONLY',draftId:draft.id,ownerId:owner.id,
    sessionToken:session.token,expectedTotalCents:draft.preview.totalCents,
    expectedCustomerEmail:email,
  });
  await authorizations.authorize({
    confirmation:'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',draftId:draft.id,ownerId:owner.id,
    sessionToken:session.token,expectedTotalCents:draft.preview.totalCents,
    expectedCustomerEmail:email,provider:'WAVE',
  });
  const customer=await pool.query(
    'SELECT customer_id FROM invoice_drafts WHERE business_id=$1 AND id=$2',
    [businessId,draft.id]
  );
  return {draft,customerId:customer.rows[0].customer_id};
}
function expectError(work,code,statusCode){
  return assert.rejects(work,error=>error instanceof WaveMappingError &&
    error.code===code&&(statusCode===undefined||error.statusCode===statusCode));
}

test('verified owner mappings assemble an exact preflight bundle without provider access',{
  skip:!DATABASE,
},async()=>{
  const url=new URL(DATABASE);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(url.pathname,'/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL,undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN,undefined);
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='wave-map-'+crypto.randomUUID();
  try{
    const {member:owner,session}=await provision({pool,businessId});
    const {member:staff,session:staffSession}=await provision({pool,businessId,role:'STAFF'});
    const {draft,customerId}=await makeAuthorized({pool,businessId,owner,session});
    const mappings=createWaveMappingStore({pool,businessId});

    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'CUSTOMER_MAPPING_REQUIRED',409);

    await expectError(mappings.verifyCustomer({
      customerId,waveCustomerId:'wave-customer-1',ownerId:staff.id,
      sessionToken:staffSession.token,
    }),'OWNER_AUTH_REQUIRED',403);

    const customerMap=await mappings.verifyCustomer({
      customerId,waveCustomerId:'wave-customer-1',ownerId:owner.id,sessionToken:session.token,
    });
    assert.equal(customerMap.waveCustomerId,'wave-customer-1');
    const duplicateCustomer=await mappings.verifyCustomer({
      customerId,waveCustomerId:'wave-customer-1',ownerId:owner.id,sessionToken:session.token,
    });
    assert.equal(duplicateCustomer.id,customerMap.id);
    await expectError(mappings.verifyCustomer({
      customerId,waveCustomerId:'wave-customer-other',ownerId:owner.id,sessionToken:session.token,
    }),'CUSTOMER_MAPPING_CONFLICT',409);

    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'PRODUCT_MAPPINGS_REQUIRED',409);

    await mappings.verifyDraftLine({
      draftId:draft.id,lineIndex:0,waveProductId:'wave-product-taxable',
      ownerId:owner.id,sessionToken:session.token,
    });
    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'PRODUCT_MAPPINGS_REQUIRED',409);
    await mappings.verifyDraftLine({
      draftId:draft.id,lineIndex:1,waveProductId:'wave-product-nontaxable',
      ownerId:owner.id,sessionToken:session.token,
    });
    await expectError(mappings.verifyDraftLine({
      draftId:draft.id,lineIndex:2,waveProductId:'invented',
      ownerId:owner.id,sessionToken:session.token,
    }),'LINE_NOT_FOUND',404);

    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'TAX_MAPPINGS_REQUIRED',409);

    await mappings.verifyTax({
      taxCode:'GST',rateMilliPercent:5000,waveSalesTaxId:'wave-tax-gst',
      ownerId:owner.id,sessionToken:session.token,
    });
    await mappings.verifyTax({
      taxCode:'QST',rateMilliPercent:9975,waveSalesTaxId:'wave-tax-qst',
      ownerId:owner.id,sessionToken:session.token,
    });

    const bundle=await mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    });
    assert.equal(bundle.businessId,businessId);
    assert.equal(bundle.customerId,'wave-customer-1');
    assert.deepEqual(bundle.productIds,['wave-product-taxable','wave-product-nontaxable']);
    assert.deepEqual(bundle.salesTaxes,{
      GST:{id:'wave-tax-gst',rateMilliPercent:5000},
      QST:{id:'wave-tax-qst',rateMilliPercent:9975},
    });
    assert.match(bundle.requestHash,/^[a-f0-9]{64}$/);

    const plan=buildWaveIssuancePreflight({
      snapshot:draft.preview,
      businessId:bundle.businessId,
      customerId:bundle.customerId,
      productIds:bundle.productIds,
      salesTaxes:bundle.salesTaxes,
    });
    assert.equal(plan.status,'READY_FOR_WAVE_ADAPTER');
    assert.equal(plan.items[0].productId,'wave-product-taxable');
    assert.equal(plan.items[1].productId,'wave-product-nontaxable');
    assert.deepEqual(plan.items[0].salesTaxIds,['wave-tax-gst','wave-tax-qst']);
    assert.deepEqual(plan.items[1].salesTaxIds,[]);
    assert.equal(plan.externalActionsPerformed.createInvoice,false);

    const counts=await pool.query(
      `SELECT mapping_type,count(*)::integer AS n
       FROM facturations_wave_mapping_events
       WHERE business_id=$1 GROUP BY mapping_type ORDER BY mapping_type`,
      [businessId]
    );
    assert.deepEqual(counts.rows,[
      {mapping_type:'CUSTOMER',n:1},
      {mapping_type:'DRAFT_LINE',n:2},
      {mapping_type:'TAX',n:2},
    ]);

    await assert.rejects(
      pool.query(`UPDATE facturations_wave_customer_mappings
                   SET wave_customer_id='changed'
                   WHERE business_id=$1 AND customer_id=$2`,[businessId,customerId]),
      error=>error.code==='23514'
    );
    await assert.rejects(
      pool.query('DELETE FROM facturations_wave_mapping_events WHERE business_id=$1',[businessId]),
      error=>error.code==='23514'
    );

    await ownerSessionRevoke();
    async function ownerSessionRevoke(){ await (createStaffAuthStore({pool,businessId})).revokeSession(session.token); }
    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'OWNER_AUTH_REQUIRED',403);
  }finally{await pool.end();}
});

test('tax rate mapping must exactly match the immutable draft rate',{skip:!DATABASE},async()=>{
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:DATABASE});
  const businessId='wave-map-rate-'+crypto.randomUUID();
  try{
    const {member:owner,session}=await provision({pool,businessId});
    const {draft,customerId}=await makeAuthorized({pool,businessId,owner,session});
    const mappings=createWaveMappingStore({pool,businessId});
    await mappings.verifyCustomer({
      customerId,waveCustomerId:'wave-customer-rate',ownerId:owner.id,sessionToken:session.token,
    });
    await mappings.verifyDraftLine({
      draftId:draft.id,lineIndex:0,waveProductId:'product-a',ownerId:owner.id,sessionToken:session.token,
    });
    await mappings.verifyDraftLine({
      draftId:draft.id,lineIndex:1,waveProductId:'product-b',ownerId:owner.id,sessionToken:session.token,
    });
    await mappings.verifyTax({
      taxCode:'GST',rateMilliPercent:5001,waveSalesTaxId:'wrong-gst',
      ownerId:owner.id,sessionToken:session.token,
    });
    await mappings.verifyTax({
      taxCode:'QST',rateMilliPercent:9975,waveSalesTaxId:'right-qst',
      ownerId:owner.id,sessionToken:session.token,
    });
    await expectError(mappings.resolveAuthorizedMappings({
      draftId:draft.id,ownerId:owner.id,sessionToken:session.token,
    }),'TAX_MAPPING_RATE_MISMATCH',409);
  }finally{await pool.end();}
});
