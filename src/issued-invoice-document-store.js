'use strict';

const crypto = require('node:crypto');
const { renderIssuedInvoicePdf } = require('./official-invoice-pdf');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RENDER_VERSION = 'invoice-pdf-v1-winansi';

class IssuedInvoiceDocumentError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuedInvoiceDocumentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new IssuedInvoiceDocumentError(code);
  }
  return value.toLowerCase();
}

function invoiceOf(row) {
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    attemptId: row.attempt_id,
    provider: row.provider,
    providerInvoiceId: row.provider_invoice_id,
    officialInvoiceNumber: row.official_invoice_number,
    status: row.status,
    deliveryState: row.delivery_state,
    snapshot: row.issued_snapshot,
    providerConfirmedAt: row.provider_confirmed_at instanceof Date
      ? row.provider_confirmed_at.toISOString() : row.provider_confirmed_at,
    materializedAt: row.materialized_at instanceof Date
      ? row.materialized_at.toISOString() : row.materialized_at,
  });
}

function resultOf(row) {
  const bytes = Buffer.isBuffer(row.pdf_bytes) ? Buffer.from(row.pdf_bytes) : null;
  return Object.freeze({
    id: row.id,
    issuedInvoiceId: row.issued_invoice_id,
    documentKind: row.document_kind,
    renderVersion: row.render_version,
    contentType: row.content_type,
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
    pdfBytes: bytes,
    deliveryState: row.delivery_state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    deliveryAuthorized: false,
    emailed: false,
  });
}

function validatePdf(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 100 || pdf.length > 2_097_152 ||
      pdf.subarray(0, 5).toString('ascii') !== '%PDF-' ||
      !pdf.subarray(Math.max(0, pdf.length - 32)).toString('ascii').includes('%%EOF')) {
    throw new IssuedInvoiceDocumentError('INVALID_PDF_BYTES', 500);
  }
  return pdf;
}

function createIssuedInvoiceDocumentStore({
  pool,
  businessId,
  renderer = renderIssuedInvoicePdf,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  if (typeof renderer !== 'function') throw new TypeError('PDF renderer required');
  const tenant = businessId.trim();

  async function getByIssuedInvoice(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'issuedInvoiceId') {
      throw new IssuedInvoiceDocumentError('INVALID_DOCUMENT_LOOKUP');
    }
    const issuedInvoiceId = uuid(input.issuedInvoiceId, 'INVALID_ISSUED_INVOICE_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_issued_invoice_documents
        WHERE business_id=$1 AND issued_invoice_id=$2`,
      [tenant, issuedInvoiceId]
    );
    if (!found.rows.length) {
      throw new IssuedInvoiceDocumentError('DOCUMENT_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  async function materialize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'issuedInvoiceId') {
      throw new IssuedInvoiceDocumentError('INVALID_DOCUMENT_REQUEST');
    }
    const issuedInvoiceId = uuid(input.issuedInvoiceId, 'INVALID_ISSUED_INVOICE_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const found = await client.query(
        `SELECT id,authorization_id,draft_id,attempt_id,provider,provider_invoice_id,
                official_invoice_number,request_hash,issued_snapshot,status,delivery_state,
                provider_confirmed_at,materialized_at
           FROM facturations_issued_invoices
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant, issuedInvoiceId]
      );
      if (!found.rows.length) {
        throw new IssuedInvoiceDocumentError('ISSUED_INVOICE_NOT_FOUND', 404);
      }
      const issued = found.rows[0];
      if (issued.status !== 'ISSUED_CONFIRMED' || issued.delivery_state !== 'NOT_AUTHORIZED') {
        throw new IssuedInvoiceDocumentError('ISSUED_INVOICE_NOT_READY', 409);
      }

      let pdf;
      try {
        pdf = validatePdf(await renderer(invoiceOf(issued)));
      } catch (error) {
        if (error instanceof IssuedInvoiceDocumentError) throw error;
        if (error && typeof error.code === 'string') {
          throw new IssuedInvoiceDocumentError(error.code, error.statusCode || 422);
        }
        throw new IssuedInvoiceDocumentError('PDF_RENDER_FAILED', 500);
      }
      const hash = crypto.createHash('sha256').update(pdf).digest('hex');

      const inserted = await client.query(
        `INSERT INTO facturations_issued_invoice_documents
           (business_id,issued_invoice_id,render_version,content_sha256,byte_length,pdf_bytes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [tenant, issuedInvoiceId, RENDER_VERSION, hash, pdf.length, pdf]
      );
      let row = inserted.rows[0];

      if (!row) {
        const prior = await client.query(
          `SELECT * FROM facturations_issued_invoice_documents
            WHERE business_id=$1 AND issued_invoice_id=$2`,
          [tenant, issuedInvoiceId]
        );
        row = prior.rows[0];
        if (!row || row.document_kind !== 'INVOICE_PDF' ||
            row.render_version !== RENDER_VERSION ||
            row.content_type !== 'application/pdf' ||
            row.content_sha256 !== hash ||
            Number(row.byte_length) !== pdf.length ||
            row.delivery_state !== 'NOT_AUTHORIZED' ||
            !Buffer.isBuffer(row.pdf_bytes) ||
            !row.pdf_bytes.equals(pdf)) {
          throw new IssuedInvoiceDocumentError('DOCUMENT_CONFLICT', 409);
        }
      }

      await client.query('COMMIT');
      transaction = false;
      return resultOf(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ materialize, getByIssuedInvoice });
}

module.exports = {
  createIssuedInvoiceDocumentStore,
  IssuedInvoiceDocumentError,
  ISSUED_INVOICE_PDF_RENDER_VERSION: RENDER_VERSION,
};
