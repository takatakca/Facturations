'use strict';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;

class ClientPortalReadError extends Error{
  constructor(code,statusCode=422){
    super(code);
    this.name='ClientPortalReadError';
    this.code=code;
    this.statusCode=statusCode;
  }
}
function uuid(value,code){
  if(typeof value!=='string' || !UUID.test(value)) throw new ClientPortalReadError(code);
  return value.toLowerCase();
}
function token(value){
  if(typeof value!=='string' || !TOKEN.test(value)){
    throw new ClientPortalReadError('CLIENT_SESSION_REQUIRED',401);
  }
  return value;
}
function money(value,code){
  const n=Number(value);
  if(!Number.isSafeInteger(n)) throw new ClientPortalReadError(code,503);
  return n;
}
function invoiceResult(row){
  const snapshot=row.issued_snapshot;
  if(!snapshot || typeof snapshot!=='object' || snapshot.currency!=='CAD' ||
     !Number.isSafeInteger(snapshot.totalCents)){
    throw new ClientPortalReadError('PORTAL_INVOICE_STORAGE_INVALID',503);
  }
  return Object.freeze({
    issuedInvoiceId:row.issued_invoice_id,
    qualifiedDocumentId:row.qualified_document_id,
    officialInvoiceNumber:row.official_invoice_number,
    invoiceDate:snapshot.invoiceDate,
    dueDate:snapshot.dueDate,
    currency:snapshot.currency,
    totalCents:snapshot.totalCents,
    qualifiedDocumentSha256:row.qualified_document_sha256,
    publishedAt:row.authorized_at instanceof Date ? row.authorized_at.toISOString() : row.authorized_at,
    payment:Object.freeze({
      paidCents:money(row.paid_cents,'INVALID_PORTAL_PAID_TOTAL'),
      refundedCents:money(row.refunded_cents,'INVALID_PORTAL_REFUND_TOTAL'),
      netPaidCents:money(row.net_paid_cents,'INVALID_PORTAL_NET_TOTAL'),
      balanceCents:money(row.balance_cents,'INVALID_PORTAL_BALANCE_TOTAL'),
      financialState:row.financial_state,
      proofScope:row.proof_scope,
      externallyVerified:row.has_verified_provider_evidence===true,
    }),
  });
}

function createClientPortalReadStore({pool,businessId,authStore}={}){
  if(!pool || typeof pool.query!=='function') throw new TypeError('Dedicated PostgreSQL pool required');
  if(typeof businessId!=='string' || !businessId.trim() || businessId.trim().length>200){
    throw new TypeError('Dedicated business ID required');
  }
  if(!authStore || typeof authStore.getSession!=='function'){
    throw new TypeError('Tenant-scoped client auth store required');
  }
  const tenant=businessId.trim();

  async function sessionOf(sessionToken){
    const session=await authStore.getSession(token(sessionToken));
    if(!session || session.businessId!==tenant ||
       typeof session.customerId!=='string' || !UUID.test(session.customerId)){
      throw new ClientPortalReadError('CLIENT_SESSION_REQUIRED',401);
    }
    return session;
  }

  const baseSelect=
    'SELECT p.issued_invoice_id,p.qualified_document_id,p.qualified_document_sha256,p.authorized_at,'+
    'i.official_invoice_number,i.issued_snapshot,'+
    's.paid_cents,s.refunded_cents,s.net_paid_cents,s.balance_cents,'+
    's.financial_state,s.proof_scope,s.has_verified_provider_evidence '+
    'FROM facturations_client_portal_publications p '+
    'JOIN facturations_issued_invoices i ON i.business_id=p.business_id AND i.id=p.issued_invoice_id '+
    'JOIN invoice_drafts d ON d.business_id=i.business_id AND d.id=i.draft_id '+
    'JOIN facturations_qualified_invoice_documents q ON q.business_id=p.business_id AND q.id=p.qualified_document_id '+
    'JOIN facturations_payment_evidence_summary s ON s.business_id=i.business_id AND s.issued_invoice_id=i.id '+
    'LEFT JOIN facturations_client_portal_publication_revocations r ON r.business_id=p.business_id AND r.publication_id=p.id ';

  async function listInvoices(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).join(',')!=='sessionToken'){
      throw new ClientPortalReadError('INVALID_PORTAL_LIST_REQUEST');
    }
    const session=await sessionOf(input.sessionToken);
    const found=await pool.query(
      baseSelect+
      "WHERE p.business_id=$1 AND p.customer_id=$2 AND d.customer_id=$2 "+
      "AND r.id IS NULL AND i.status='ISSUED_CONFIRMED' "+
      "AND q.document_kind='QUALIFIED_INVOICE_PDF' "+
      "AND q.content_sha256=p.qualified_document_sha256 "+
      "ORDER BY p.authorized_at DESC,p.id DESC LIMIT 100",
      [tenant,session.customerId]
    );
    return Object.freeze(found.rows.map(invoiceResult));
  }

  async function getInvoice(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='issuedInvoiceId,sessionToken'){
      throw new ClientPortalReadError('INVALID_PORTAL_INVOICE_REQUEST');
    }
    const session=await sessionOf(input.sessionToken);
    const issuedInvoiceId=uuid(input.issuedInvoiceId,'INVALID_ISSUED_INVOICE_ID');
    const found=await pool.query(
      baseSelect+
      "WHERE p.business_id=$1 AND p.customer_id=$2 AND d.customer_id=$2 "+
      "AND p.issued_invoice_id=$3 AND r.id IS NULL "+
      "AND i.status='ISSUED_CONFIRMED' "+
      "AND q.document_kind='QUALIFIED_INVOICE_PDF' "+
      "AND q.content_sha256=p.qualified_document_sha256",
      [tenant,session.customerId,issuedInvoiceId]
    );
    if(!found.rows.length) throw new ClientPortalReadError('PORTAL_INVOICE_NOT_FOUND',404);
    return invoiceResult(found.rows[0]);
  }

  async function getQualifiedPdf(input){
    if(!input || typeof input!=='object' || Array.isArray(input) ||
       Object.keys(input).sort().join(',')!=='qualifiedDocumentId,sessionToken'){
      throw new ClientPortalReadError('INVALID_PORTAL_PDF_REQUEST');
    }
    const session=await sessionOf(input.sessionToken);
    const qualifiedDocumentId=uuid(input.qualifiedDocumentId,'INVALID_QUALIFIED_DOCUMENT_ID');
    const sql=
      "SELECT q.id,q.issued_invoice_id,q.content_type,q.content_sha256,q.byte_length,q.pdf_bytes "+
      "FROM facturations_client_portal_publications p "+
      "JOIN facturations_issued_invoices i ON i.business_id=p.business_id AND i.id=p.issued_invoice_id "+
      "JOIN invoice_drafts d ON d.business_id=i.business_id AND d.id=i.draft_id "+
      "JOIN facturations_qualified_invoice_documents q ON q.business_id=p.business_id AND q.id=p.qualified_document_id "+
      "LEFT JOIN facturations_client_portal_publication_revocations r ON r.business_id=p.business_id AND r.publication_id=p.id "+
      "WHERE p.business_id=$1 AND p.customer_id=$2 AND d.customer_id=$2 "+
      "AND p.qualified_document_id=$3 AND r.id IS NULL "+
      "AND i.status='ISSUED_CONFIRMED' AND q.document_kind='QUALIFIED_INVOICE_PDF' "+
      "AND q.content_sha256=p.qualified_document_sha256";
    const found=await pool.query(sql,[tenant,session.customerId,qualifiedDocumentId]);
    if(!found.rows.length) throw new ClientPortalReadError('PORTAL_PDF_NOT_FOUND',404);
    const row=found.rows[0];
    if(row.content_type!=='application/pdf' || !Buffer.isBuffer(row.pdf_bytes) ||
       Number(row.byte_length)!==row.pdf_bytes.length){
      throw new ClientPortalReadError('PORTAL_PDF_STORAGE_INVALID',503);
    }
    return Object.freeze({
      qualifiedDocumentId:row.id,
      issuedInvoiceId:row.issued_invoice_id,
      contentType:row.content_type,
      contentSha256:row.content_sha256,
      byteLength:Number(row.byte_length),
      pdfBytes:Buffer.from(row.pdf_bytes),
    });
  }

  return Object.freeze({listInvoices,getInvoice,getQualifiedPdf});
}

module.exports={createClientPortalReadStore,ClientPortalReadError};
