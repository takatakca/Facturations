'use strict';

const crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const TAX_CODE=/^[A-Z0-9_-]{1,20}$/;

class WaveMappingError extends Error{
  constructor(code,statusCode=422){
    super(code);this.name='WaveMappingError';this.code=code;this.statusCode=statusCode;
  }
}
function externalId(value,code){
  if(typeof value!=='string'||value.trim().length<1||value.trim().length>512||
     /[\u0000-\u001f\u007f]/u.test(value)){
    throw new WaveMappingError(code);
  }
  return value.trim();
}
function uuid(value,code){
  if(typeof value!=='string'||!UUID.test(value)) throw new WaveMappingError(code);
  return value;
}
function ownerInput(input,extraFields){
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new WaveMappingError('INVALID_MAPPING');
  const expected=['ownerId','sessionToken',...extraFields].sort().join(',');
  if(Object.keys(input).sort().join(',')!==expected) throw new WaveMappingError('INVALID_MAPPING');
  uuid(input.ownerId,'INVALID_OWNER_ID');
  if(typeof input.sessionToken!=='string'||!TOKEN.test(input.sessionToken)){
    throw new WaveMappingError('INVALID_SESSION',401);
  }
  return input;
}
function digest(token){return crypto.createHash('sha256').update(token,'utf8').digest();}

function createWaveMappingStore({pool,businessId}){
  if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function'){
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if(typeof businessId!=='string'||!businessId.trim()||businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  const tenant=businessId.trim();

  async function requireOwner(client,ownerId,sessionToken){
    const found=await client.query(
      `SELECT u.id FROM facturations_staff_sessions s
       JOIN facturations_staff_users u
         ON u.business_id=s.business_id AND u.id=s.user_id
       WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
       FOR SHARE OF s,u`,
      [tenant,ownerId,digest(sessionToken)]
    );
    if(!found.rows.length) throw new WaveMappingError('OWNER_AUTH_REQUIRED',403);
  }
  async function event(client,type,id,ownerId){
    await client.query(
      `INSERT INTO facturations_wave_mapping_events
       (business_id,mapping_type,mapping_id,verified_by,action)
       VALUES ($1,$2,$3,$4,'VERIFIED')`,
      [tenant,type,id,ownerId]
    );
  }
  async function verifyCustomer(input){
    ownerInput(input,['customerId','waveCustomerId']);
    const customerId=uuid(input.customerId,'INVALID_CUSTOMER_ID');
    const waveCustomerId=externalId(input.waveCustomerId,'INVALID_WAVE_CUSTOMER_ID');
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      await requireOwner(client,input.ownerId,input.sessionToken);
      const customer=await client.query(
        'SELECT id FROM invoice_customers WHERE business_id=$1 AND id=$2 FOR SHARE',
        [tenant,customerId]
      );
      if(!customer.rows.length) throw new WaveMappingError('CUSTOMER_NOT_FOUND',404);
      const existing=await client.query(
        `SELECT id,wave_customer_id,verified_by,verified_at
         FROM facturations_wave_customer_mappings
         WHERE business_id=$1 AND customer_id=$2 FOR SHARE`,
        [tenant,customerId]
      );
      if(existing.rows.length){
        const row=existing.rows[0];
        if(row.wave_customer_id!==waveCustomerId) throw new WaveMappingError('CUSTOMER_MAPPING_CONFLICT',409);
        await client.query('COMMIT');tx=false;
        return Object.freeze({id:row.id,customerId,waveCustomerId,verifiedBy:row.verified_by,
          verifiedAt:row.verified_at instanceof Date?row.verified_at.toISOString():row.verified_at});
      }
      let inserted;
      try{
        inserted=await client.query(
          `INSERT INTO facturations_wave_customer_mappings
           (business_id,customer_id,wave_customer_id,verified_by)
           VALUES ($1,$2,$3,$4)
           RETURNING id,wave_customer_id,verified_by,verified_at`,
          [tenant,customerId,waveCustomerId,input.ownerId]
        );
      }catch(error){
        if(error?.code==='23505') throw new WaveMappingError('CUSTOMER_MAPPING_CONFLICT',409);
        throw error;
      }
      const row=inserted.rows[0];
      await event(client,'CUSTOMER',row.id,input.ownerId);
      await client.query('COMMIT');tx=false;
      return Object.freeze({id:row.id,customerId,waveCustomerId:row.wave_customer_id,
        verifiedBy:row.verified_by,verifiedAt:row.verified_at instanceof Date?row.verified_at.toISOString():row.verified_at});
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function verifyTax(input){
    ownerInput(input,['rateMilliPercent','taxCode','waveSalesTaxId']);
    if(typeof input.taxCode!=='string'||!TAX_CODE.test(input.taxCode)) throw new WaveMappingError('INVALID_TAX_CODE');
    if(!Number.isSafeInteger(input.rateMilliPercent)||input.rateMilliPercent<0||input.rateMilliPercent>100000){
      throw new WaveMappingError('INVALID_TAX_RATE');
    }
    const waveSalesTaxId=externalId(input.waveSalesTaxId,'INVALID_WAVE_SALES_TAX_ID');
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      await requireOwner(client,input.ownerId,input.sessionToken);
      const existing=await client.query(
        `SELECT id,rate_milli_percent,wave_sales_tax_id,verified_by,verified_at
         FROM facturations_wave_tax_mappings
         WHERE business_id=$1 AND tax_code=$2 FOR SHARE`,
        [tenant,input.taxCode]
      );
      if(existing.rows.length){
        const row=existing.rows[0];
        if(row.rate_milli_percent!==input.rateMilliPercent||row.wave_sales_tax_id!==waveSalesTaxId){
          throw new WaveMappingError('TAX_MAPPING_CONFLICT',409);
        }
        await client.query('COMMIT');tx=false;
        return Object.freeze({id:row.id,taxCode:input.taxCode,rateMilliPercent:row.rate_milli_percent,
          waveSalesTaxId:row.wave_sales_tax_id,verifiedBy:row.verified_by});
      }
      let inserted;
      try{
        inserted=await client.query(
          `INSERT INTO facturations_wave_tax_mappings
           (business_id,tax_code,rate_milli_percent,wave_sales_tax_id,verified_by)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id,rate_milli_percent,wave_sales_tax_id,verified_by,verified_at`,
          [tenant,input.taxCode,input.rateMilliPercent,waveSalesTaxId,input.ownerId]
        );
      }catch(error){
        if(error?.code==='23505') throw new WaveMappingError('TAX_MAPPING_CONFLICT',409);
        throw error;
      }
      const row=inserted.rows[0];
      await event(client,'TAX',row.id,input.ownerId);
      await client.query('COMMIT');tx=false;
      return Object.freeze({id:row.id,taxCode:input.taxCode,rateMilliPercent:row.rate_milli_percent,
        waveSalesTaxId:row.wave_sales_tax_id,verifiedBy:row.verified_by});
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function verifyDraftLine(input){
    ownerInput(input,['draftId','lineIndex','waveProductId']);
    const draftId=uuid(input.draftId,'INVALID_DRAFT_ID');
    if(!Number.isSafeInteger(input.lineIndex)||input.lineIndex<0||input.lineIndex>49){
      throw new WaveMappingError('INVALID_LINE_INDEX');
    }
    const waveProductId=externalId(input.waveProductId,'INVALID_WAVE_PRODUCT_ID');
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      await requireOwner(client,input.ownerId,input.sessionToken);
      const draft=await client.query(
        `SELECT request_hash,snapshot FROM invoice_drafts
         WHERE business_id=$1 AND id=$2 AND status='DRAFT' FOR SHARE`,
        [tenant,draftId]
      );
      if(!draft.rows.length) throw new WaveMappingError('DRAFT_NOT_FOUND',404);
      const rowDraft=draft.rows[0];
      if(!Array.isArray(rowDraft.snapshot?.lines)||input.lineIndex>=rowDraft.snapshot.lines.length){
        throw new WaveMappingError('LINE_NOT_FOUND',404);
      }
      const existing=await client.query(
        `SELECT id,request_hash,wave_product_id,verified_by,verified_at
         FROM facturations_wave_draft_line_mappings
         WHERE business_id=$1 AND draft_id=$2 AND line_index=$3 FOR SHARE`,
        [tenant,draftId,input.lineIndex]
      );
      if(existing.rows.length){
        const row=existing.rows[0];
        if(row.request_hash!==rowDraft.request_hash||row.wave_product_id!==waveProductId){
          throw new WaveMappingError('LINE_MAPPING_CONFLICT',409);
        }
        await client.query('COMMIT');tx=false;
        return Object.freeze({id:row.id,draftId,lineIndex:input.lineIndex,
          waveProductId:row.wave_product_id,requestHash:row.request_hash,verifiedBy:row.verified_by});
      }
      let inserted;
      try{
        inserted=await client.query(
          `INSERT INTO facturations_wave_draft_line_mappings
           (business_id,draft_id,request_hash,line_index,wave_product_id,verified_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id,request_hash,wave_product_id,verified_by,verified_at`,
          [tenant,draftId,rowDraft.request_hash,input.lineIndex,waveProductId,input.ownerId]
        );
      }catch(error){
        if(error?.code==='23505') throw new WaveMappingError('LINE_MAPPING_CONFLICT',409);
        throw error;
      }
      const row=inserted.rows[0];
      await event(client,'DRAFT_LINE',row.id,input.ownerId);
      await client.query('COMMIT');tx=false;
      return Object.freeze({id:row.id,draftId,lineIndex:input.lineIndex,
        waveProductId:row.wave_product_id,requestHash:row.request_hash,verifiedBy:row.verified_by});
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  async function resolveAuthorizedMappings(input){
    ownerInput(input,['draftId']);
    const draftId=uuid(input.draftId,'INVALID_DRAFT_ID');
    const client=await pool.connect();let tx=false;
    try{
      await client.query('BEGIN');tx=true;
      await requireOwner(client,input.ownerId,input.sessionToken);
      const draft=await client.query(
        `SELECT d.customer_id,d.request_hash,d.snapshot,a.id AS authorization_id
         FROM invoice_drafts d
         JOIN facturations_issuance_authorizations a
           ON a.business_id=d.business_id AND a.draft_id=d.id
          AND a.request_hash=d.request_hash
          AND a.state='AUTHORIZED_PENDING_PROVIDER'
         WHERE d.business_id=$1 AND d.id=$2 AND d.status='DRAFT'
         FOR SHARE OF d,a`,
        [tenant,draftId]
      );
      if(!draft.rows.length) throw new WaveMappingError('ISSUANCE_AUTHORIZATION_REQUIRED',409);
      const d=draft.rows[0];
      const customer=await client.query(
        `SELECT wave_customer_id FROM facturations_wave_customer_mappings
         WHERE business_id=$1 AND customer_id=$2`,
        [tenant,d.customer_id]
      );
      if(!customer.rows.length) throw new WaveMappingError('CUSTOMER_MAPPING_REQUIRED',409);

      const lineCount=Array.isArray(d.snapshot?.lines)?d.snapshot.lines.length:0;
      if(lineCount<1) throw new WaveMappingError('INVALID_DRAFT_SNAPSHOT',409);
      const lines=await client.query(
        `SELECT line_index,wave_product_id,request_hash
         FROM facturations_wave_draft_line_mappings
         WHERE business_id=$1 AND draft_id=$2 ORDER BY line_index`,
        [tenant,draftId]
      );
      if(lines.rows.length!==lineCount) throw new WaveMappingError('PRODUCT_MAPPINGS_REQUIRED',409);
      const productIds=new Array(lineCount);
      for(const row of lines.rows){
        if(row.request_hash!==d.request_hash||row.line_index<0||row.line_index>=lineCount||
           productIds[row.line_index]!==undefined){
          throw new WaveMappingError('PRODUCT_MAPPINGS_INVALID',409);
        }
        productIds[row.line_index]=row.wave_product_id;
      }
      if(productIds.some(value=>value===undefined)){
        throw new WaveMappingError('PRODUCT_MAPPINGS_REQUIRED',409);
      }

      const taxes=Array.isArray(d.snapshot?.taxes)?d.snapshot.taxes:[];
      const salesTaxes={};
      for(const tax of taxes){
        if(!tax||typeof tax.code!=='string'||!TAX_CODE.test(tax.code)||
           !Number.isSafeInteger(tax.rateMilliPercent)){
          throw new WaveMappingError('INVALID_DRAFT_SNAPSHOT',409);
        }
        const mapped=await client.query(
          `SELECT rate_milli_percent,wave_sales_tax_id
           FROM facturations_wave_tax_mappings
           WHERE business_id=$1 AND tax_code=$2`,
          [tenant,tax.code]
        );
        if(!mapped.rows.length) throw new WaveMappingError('TAX_MAPPINGS_REQUIRED',409);
        const row=mapped.rows[0];
        if(row.rate_milli_percent!==tax.rateMilliPercent){
          throw new WaveMappingError('TAX_MAPPING_RATE_MISMATCH',409);
        }
        salesTaxes[tax.code]=Object.freeze({id:row.wave_sales_tax_id,rateMilliPercent:row.rate_milli_percent});
      }
      await client.query('COMMIT');tx=false;
      return Object.freeze({
        businessId:tenant,
        customerId:customer.rows[0].wave_customer_id,
        productIds:Object.freeze(productIds),
        salesTaxes:Object.freeze(salesTaxes),
        authorizationId:d.authorization_id,
        requestHash:d.request_hash,
      });
    }catch(error){
      if(tx){try{await client.query('ROLLBACK');}catch{/* preserve */}}
      throw error;
    }finally{client.release();}
  }

  return Object.freeze({verifyCustomer,verifyTax,verifyDraftLine,resolveAuthorizedMappings});
}
module.exports={createWaveMappingStore,WaveMappingError};
