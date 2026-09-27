'use strict';

const crypto=require('node:crypto');

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const REASON=/^[A-Z][A-Z0-9_]{0,63}$/;
const AUTHORIZE='AUTHORIZE_CLIENT_PORTAL_PUBLICATION';
const REVOKE='REVOKE_CLIENT_PORTAL_PUBLICATION';

class ClientPortalPublicationError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='ClientPortalPublicationError';
    this.code=code;
    this.statusCode=statusCode;
  }
}
function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new ClientPortalPublicationError(code);
  return value.toLowerCase();
}
function digest(token){
  return crypto.createHash('sha256').update(token,'utf8').digest();
}
function publicationOf(row){
  return Object.freeze({
    id:row.id,
    issuedInvoiceId:row.issued_invoice_id,
    qualifiedDocumentId:row.qualified_document_id,
    customerId:row.customer_id,
    qualifiedDocumentSha256:row.qualified_document_sha256,
    authorizedBy:row.authorized_by,
    confirmation:row.confirmation,
    authorizedAt:row.authorized_at instanceof Date ? row.authorized_at.toISOString() : row.authorized_at,
    revoked:row.revoked===true,
    revokedAt:row.revoked_at instanceof Date ? row.revoked_at.toISOString() : (row.revoked_at||null),
    revocationReason:row.reason_code||null,
  });
}

function createClientPortalPublicationStore({pool,businessId}={}){
  if(!pool || typeof pool.connect!=='function' || typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function requireOwner(client,{ownerId,sessionToken}){
    const id=uuid(ownerId,'INVALID_OWNER_ID');
    if(typeof sessionToken!=='string' || !TOKEN.test(sessionToken)){
      throw new ClientPortalPublicationError('INVALID_OWNER_SESSION',401);
    }
    const found=await client.query(
      `SELECT u.id
         FROM facturations_staff_sessions s
         JOIN facturations_staff_users u
           ON u.business_id=s.business_id AND u.id=s.user_id
        WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
          AND s.revoked_at IS NULL AND s.expires_at>now()
          AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
        FOR SHARE OF s,u`,
      [tenant,id,digest(sessionToken)]
    );
    if(!found.rows.length) throw new ClientPortalPublicationError('OWNER_AUTH_REQUIRED',403);
    return id;
  }

  async function getByQualifiedDocument(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='qualifiedDocumentId'){
      throw new ClientPortalPublicationError('INVALID_PUBLICATION_LOOKUP');
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const found=await pool.query(
      `SELECT p.*, (r.id IS NOT NULL) AS revoked,r.revoked_at,r.reason_code
         FROM facturations_client_portal_publications p
         LEFT JOIN facturations_client_portal_publication_revocations r
           ON r.business_id=p.business_id AND r.publication_id=p.id
        WHERE p.business_id=$1 AND p.qualified_document_id=$2`,
      [tenant,qualifiedDocumentId]
    );
    if(!found.rows.length) throw new ClientPortalPublicationError('PUBLICATION_NOT_FOUND',404);
    return publicationOf(found.rows[0]);
  }

  async function authorize(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!==
         'confirmation,ownerId,qualifiedDocumentId,sessionToken'){
      throw new ClientPortalPublicationError('INVALID_PUBLICATION_REQUEST');
    }
    if(input.confirmation!==AUTHORIZE){
      throw new ClientPortalPublicationError('PUBLICATION_CONFIRMATION_REQUIRED');
    }
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;
      const ownerId=await requireOwner(client,input);

      const chain=await client.query(
        `SELECT q.id AS qualified_document_id,q.issued_invoice_id,q.content_sha256,
                q.document_kind,q.delivery_state,
                i.status AS invoice_status,i.draft_id,
                d.customer_id,c.email_normalized
           FROM facturations_qualified_invoice_documents q
           JOIN facturations_issued_invoices i
             ON i.business_id=q.business_id AND i.id=q.issued_invoice_id
           JOIN invoice_drafts d
             ON d.business_id=i.business_id AND d.id=i.draft_id
           JOIN invoice_customers c
             ON c.business_id=d.business_id AND c.id=d.customer_id
          WHERE q.business_id=$1 AND q.id=$2
          FOR SHARE OF q,i,d,c`,
        [tenant,qualifiedDocumentId]
      );
      if(!chain.rows.length) throw new ClientPortalPublicationError('QUALIFIED_DOCUMENT_NOT_FOUND',404);
      const row=chain.rows[0];
      if(row.document_kind!=='QUALIFIED_INVOICE_PDF' ||
         row.invoice_status!=='ISSUED_CONFIRMED' ||
         typeof row.email_normalized!=='string'){
        throw new ClientPortalPublicationError('PUBLICATION_SOURCE_NOT_READY',409);
      }

      const inserted=await client.query(
        `INSERT INTO facturations_client_portal_publications
           (business_id,issued_invoice_id,qualified_document_id,customer_id,
            qualified_document_sha256,authorized_by,confirmation)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING *,false AS revoked,NULL::timestamptz AS revoked_at,NULL::text AS reason_code`,
        [tenant,row.issued_invoice_id,row.qualified_document_id,row.customer_id,
         row.content_sha256,ownerId,AUTHORIZE]
      );
      let saved=inserted.rows[0];
      if(!saved){
        const prior=await client.query(
          `SELECT p.*, (r.id IS NOT NULL) AS revoked,r.revoked_at,r.reason_code
             FROM facturations_client_portal_publications p
             LEFT JOIN facturations_client_portal_publication_revocations r
               ON r.business_id=p.business_id AND r.publication_id=p.id
            WHERE p.business_id=$1 AND
              (p.issued_invoice_id=$2 OR p.qualified_document_id=$3)`,
          [tenant,row.issued_invoice_id,row.qualified_document_id]
        );
        if(prior.rows.length!==1) throw new ClientPortalPublicationError('PUBLICATION_CONFLICT',409);
        saved=prior.rows[0];
        if(saved.issued_invoice_id!==row.issued_invoice_id ||
           saved.qualified_document_id!==row.qualified_document_id ||
           saved.customer_id!==row.customer_id ||
           saved.qualified_document_sha256!==row.content_sha256 ||
           saved.authorized_by!==ownerId ||
           saved.confirmation!==AUTHORIZE){
          throw new ClientPortalPublicationError('PUBLICATION_CONFLICT',409);
        }
      }

      await client.query('COMMIT');
      transaction=false;
      return publicationOf(saved);
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  async function revoke(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!==
         'confirmation,ownerId,publicationId,reasonCode,sessionToken'){
      throw new ClientPortalPublicationError('INVALID_REVOCATION_REQUEST');
    }
    if(input.confirmation!==REVOKE){
      throw new ClientPortalPublicationError('REVOCATION_CONFIRMATION_REQUIRED');
    }
    const publicationId=uuid(input.publicationId,'INVALID_PUBLICATION_ID');
    if(typeof input.reasonCode!=='string' || !REASON.test(input.reasonCode)){
      throw new ClientPortalPublicationError('INVALID_REVOCATION_REASON');
    }

    const client=await pool.connect();
    let transaction=false;
    try{
      await client.query('BEGIN');
      transaction=true;
      const ownerId=await requireOwner(client,input);
      const publication=await client.query(
        `SELECT id FROM facturations_client_portal_publications
          WHERE business_id=$1 AND id=$2 FOR SHARE`,
        [tenant,publicationId]
      );
      if(!publication.rows.length) throw new ClientPortalPublicationError('PUBLICATION_NOT_FOUND',404);

      const inserted=await client.query(
        `INSERT INTO facturations_client_portal_publication_revocations
           (business_id,publication_id,revoked_by,confirmation,reason_code)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id,publication_id) DO NOTHING
         RETURNING id,revoked_at,reason_code`,
        [tenant,publicationId,ownerId,REVOKE,input.reasonCode]
      );
      if(!inserted.rows.length){
        const prior=await client.query(
          `SELECT revoked_by,confirmation,reason_code
             FROM facturations_client_portal_publication_revocations
            WHERE business_id=$1 AND publication_id=$2`,
          [tenant,publicationId]
        );
        const row=prior.rows[0];
        if(!row || row.revoked_by!==ownerId ||
           row.confirmation!==REVOKE || row.reason_code!==input.reasonCode){
          throw new ClientPortalPublicationError('PUBLICATION_ALREADY_REVOKED',409);
        }
      }

      const full=await client.query(
        `SELECT p.*,true AS revoked,r.revoked_at,r.reason_code
           FROM facturations_client_portal_publications p
           JOIN facturations_client_portal_publication_revocations r
             ON r.business_id=p.business_id AND r.publication_id=p.id
          WHERE p.business_id=$1 AND p.id=$2`,
        [tenant,publicationId]
      );
      await client.query('COMMIT');
      transaction=false;
      return publicationOf(full.rows[0]);
    }catch(error){
      if(transaction){
        try{await client.query('ROLLBACK');}catch{}
      }
      throw error;
    }finally{
      client.release();
    }
  }

  return Object.freeze({authorize,revoke,getByQualifiedDocument});
}

module.exports={createClientPortalPublicationStore,ClientPortalPublicationError};
