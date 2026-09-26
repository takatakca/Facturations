'use strict';

const crypto=require('node:crypto');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;

class ClientPortalAuthError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='ClientPortalAuthError';
    this.code=code;
    this.statusCode=statusCode;
  }
}
function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new ClientPortalAuthError(code);
  return value.toLowerCase();
}
function digest(token){
  return crypto.createHash('sha256').update(token,'utf8').digest();
}
function normalizeEmail(value){
  if(typeof value!=='string') throw new ClientPortalAuthError('INVALID_CLIENT_EMAIL');
  const email=value.trim().toLowerCase();
  if(email.length<3 || email.length>254 ||
     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
     /[\u0000-\u001f\u007f]/u.test(email)){
    throw new ClientPortalAuthError('INVALID_CLIENT_EMAIL');
  }
  return email;
}

function createClientPortalAuthStore({pool,businessId}={}){
  if(!pool || typeof pool.connect!=='function' || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function issueAccessLink(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='customerId,ownerId,sessionToken'){
      throw new ClientPortalAuthError('INVALID_CLIENT_LINK_REQUEST');
    }
    const customerId=uuid(input.customerId,'INVALID_CUSTOMER_ID');
    const ownerId=uuid(input.ownerId,'INVALID_OWNER_ID');
    if(typeof input.sessionToken!=='string' || !TOKEN.test(input.sessionToken)){
      throw new ClientPortalAuthError('INVALID_OWNER_SESSION',401);
    }
    const sessionHash=digest(input.sessionToken);
    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;

      const owner=await client.query(
        `SELECT u.id
           FROM facturations_staff_sessions s
           JOIN facturations_staff_users u
             ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at>now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`,
        [tenant,ownerId,sessionHash]
      );
      if(!owner.rows.length) throw new ClientPortalAuthError('OWNER_AUTH_REQUIRED',403);

      const customers=await client.query(
        `SELECT id,email_normalized
           FROM invoice_customers
          WHERE business_id=$1 AND id=$2
          FOR UPDATE`,
        [tenant,customerId]
      );
      if(!customers.rows.length) throw new ClientPortalAuthError('CUSTOMER_NOT_FOUND',404);
      const email=normalizeEmail(customers.rows[0].email_normalized);

      const priorUser=await client.query(
        `SELECT id,email_normalized
           FROM facturations_client_portal_users
          WHERE business_id=$1 AND customer_id=$2
          FOR UPDATE`,
        [tenant,customerId]
      );
      if(!priorUser.rows.length){
        await client.query(
          `INSERT INTO facturations_client_portal_users
             (business_id,customer_id,email_normalized)
           VALUES ($1,$2,$3)`,
          [tenant,customerId,email]
        );
      }else if(priorUser.rows[0].email_normalized!==email){
        await client.query(
          `UPDATE facturations_client_portal_users
              SET email_normalized=$3,email_verified_at=NULL
            WHERE business_id=$1 AND customer_id=$2`,
          [tenant,customerId,email]
        );
        await client.query(
          `UPDATE facturations_client_sessions
              SET revoked_at=now()
            WHERE business_id=$1 AND customer_id=$2 AND revoked_at IS NULL`,
          [tenant,customerId]
        );
      }

      await client.query(
        `UPDATE facturations_client_access_links
            SET revoked_at=now()
          WHERE business_id=$1 AND customer_id=$2
            AND consumed_at IS NULL AND revoked_at IS NULL`,
        [tenant,customerId]
      );

      const token=crypto.randomBytes(32).toString('base64url');
      const inserted=await client.query(
        `INSERT INTO facturations_client_access_links
           (business_id,customer_id,issued_by,token_hash,expected_email_normalized,expires_at)
         VALUES ($1,$2,$3,$4,$5,now()+interval '30 minutes')
         RETURNING expires_at`,
        [tenant,customerId,ownerId,digest(token),email]
      );
      await client.query('COMMIT');
      transaction=false;
      return Object.freeze({
        token,
        customerId,
        email,
        purpose:'SIGN_IN_OR_RECOVERY',
        expiresAt:inserted.rows[0].expires_at.toISOString(),
      });
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  async function redeemAccessLink(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='token' ||
       typeof input.token!=='string' || !TOKEN.test(input.token)){
      throw new ClientPortalAuthError('INVALID_CLIENT_ACCESS_LINK',401);
    }
    const tokenHash=digest(input.token);
    const lookup=await pool.query(
      `SELECT customer_id
         FROM facturations_client_access_links
        WHERE business_id=$1 AND token_hash=$2`,
      [tenant,tokenHash]
    );
    if(!lookup.rows.length) throw new ClientPortalAuthError('INVALID_CLIENT_ACCESS_LINK',401);

    const customerId=lookup.rows[0].customer_id;
    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;

      const customer=await client.query(
        `SELECT id,email_normalized
           FROM invoice_customers
          WHERE business_id=$1 AND id=$2
          FOR UPDATE`,
        [tenant,customerId]
      );
      const link=await client.query(
        `SELECT id,expected_email_normalized,consumed_at,revoked_at,
                (expires_at>now()) AS still_valid
           FROM facturations_client_access_links
          WHERE business_id=$1 AND customer_id=$2 AND token_hash=$3
          FOR UPDATE`,
        [tenant,customerId,tokenHash]
      );
      const portal=await client.query(
        `SELECT id,email_normalized,enabled
           FROM facturations_client_portal_users
          WHERE business_id=$1 AND customer_id=$2
          FOR UPDATE`,
        [tenant,customerId]
      );
      const customerRow=customer.rows[0];
      const linkRow=link.rows[0];
      const portalRow=portal.rows[0];
      if(!customerRow || !linkRow || !portalRow || !portalRow.enabled ||
         linkRow.consumed_at || linkRow.revoked_at || !linkRow.still_valid ||
         customerRow.email_normalized!==linkRow.expected_email_normalized ||
         portalRow.email_normalized!==linkRow.expected_email_normalized){
        throw new ClientPortalAuthError('INVALID_CLIENT_ACCESS_LINK',401);
      }

      await client.query(
        `UPDATE facturations_client_portal_users
            SET email_verified_at=COALESCE(email_verified_at,now())
          WHERE business_id=$1 AND customer_id=$2`,
        [tenant,customerId]
      );
      await client.query(
        `UPDATE facturations_client_access_links SET consumed_at=now()
          WHERE business_id=$1 AND id=$2`,
        [tenant,linkRow.id]
      );
      await client.query(
        `UPDATE facturations_client_sessions SET revoked_at=now()
          WHERE business_id=$1 AND customer_id=$2 AND revoked_at IS NULL`,
        [tenant,customerId]
      );

      const sessionToken=crypto.randomBytes(32).toString('base64url');
      const inserted=await client.query(
        `INSERT INTO facturations_client_sessions
           (business_id,customer_id,token_hash,expires_at)
         VALUES ($1,$2,$3,now()+interval '12 hours')
         RETURNING expires_at`,
        [tenant,customerId,digest(sessionToken)]
      );
      await client.query('COMMIT');
      transaction=false;
      return Object.freeze({
        token:sessionToken,
        expiresAt:inserted.rows[0].expires_at.toISOString(),
        customer:Object.freeze({
          id:customerId,
          email:linkRow.expected_email_normalized,
          businessId:tenant,
        }),
      });
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  async function getSession(token){
    if(typeof token!=='string' || !TOKEN.test(token)) return null;
    const found=await pool.query(
      `SELECT s.customer_id,c.email_normalized
         FROM facturations_client_sessions s
         JOIN facturations_client_portal_users u
           ON u.business_id=s.business_id AND u.customer_id=s.customer_id
         JOIN invoice_customers c
           ON c.business_id=s.business_id AND c.id=s.customer_id
        WHERE s.business_id=$1 AND s.token_hash=$2
          AND s.revoked_at IS NULL AND s.expires_at>now()
          AND u.enabled AND u.email_verified_at IS NOT NULL
          AND u.email_normalized=c.email_normalized`,
      [tenant,digest(token)]
    );
    if(!found.rows.length) return null;
    return Object.freeze({
      customerId:found.rows[0].customer_id,
      email:found.rows[0].email_normalized,
      businessId:tenant,
    });
  }

  async function revokeSession(token){
    if(typeof token!=='string' || !TOKEN.test(token)) return false;
    const updated=await pool.query(
      `UPDATE facturations_client_sessions SET revoked_at=now()
        WHERE business_id=$1 AND token_hash=$2 AND revoked_at IS NULL
        RETURNING id`,
      [tenant,digest(token)]
    );
    return updated.rows.length===1;
  }

  async function revokeAllSessionsForCustomer(customerIdInput){
    const customerId=uuid(customerIdInput,'INVALID_CUSTOMER_ID');
    const updated=await pool.query(
      `UPDATE facturations_client_sessions SET revoked_at=now()
        WHERE business_id=$1 AND customer_id=$2 AND revoked_at IS NULL
        RETURNING id`,
      [tenant,customerId]
    );
    return updated.rows.length;
  }

  return Object.freeze({
    issueAccessLink,
    redeemAccessLink,
    getSession,
    revokeSession,
    revokeAllSessionsForCustomer,
  });
}

module.exports={createClientPortalAuthStore,ClientPortalAuthError};
