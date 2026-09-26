'use strict';

const crypto = require('node:crypto');
const { renderIssuedInvoicePdf } = require('./official-invoice-pdf');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RENDER_VERSION = 'invoice-pdf-v2-issuer-winansi';

class QualifiedInvoiceDocumentError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'QualifiedInvoiceDocumentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new QualifiedInvoiceDocumentError(code);
  }
  return value.toLowerCase();
}

function invoiceOf(row) {
  return Object.freeze({
    id: row.issued_invoice_id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    attemptId: row.attempt_id,
    provider: row.provider,
    providerInvoiceId: row.provider_invoice_id,
    officialInvoiceNumber: row.official_invoice_number,
    status: row.invoice_status,
    deliveryState: row.invoice_delivery_state,
    snapshot: row.issued_snapshot,
    providerConfirmedAt: row.provider_confirmed_at instanceof Date
      ? row.provider_confirmed_at.toISOString() : row.provider_confirmed_at,
    materializedAt: row.invoice_materialized_at instanceof Date
      ? row.invoice_materialized_at.toISOString() : row.invoice_materialized_at,
  });
}

function profileOf(row) {
  return Object.freeze({
    id: row.issuer_profile_id,
    version: Number(row.profile_version),
    legalName: row.legal_name,
    displayName: row.display_name,
    addressLines: Object.freeze([...row.address_lines]),
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    contactEmail: row.contact_email || null,
    contactPhone: row.contact_phone || null,
    taxRegistrations: Object.freeze(row.tax_registrations.map(item => Object.freeze({
      scheme: item.scheme,
      registrationNumber: item.registrationNumber,
    }))),
    profileHash: row.profile_hash,
    state: row.profile_state,
  });
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    bindingId: row.binding_id,
    issuedInvoiceId: row.issued_invoice_id,
    sourceDocumentId: row.source_document_id,
    sourceDocumentSha256: row.source_document_sha256,
    issuerProfileId: row.issuer_profile_id,
    issuerProfileHash: row.issuer_profile_hash,
    issuerProfileVersion: Number(row.issuer_profile_version),
    documentKind: row.document_kind,
    renderVersion: row.render_version,
    contentType: row.content_type,
    contentSha256: row.content_sha256,
    byteLength: Number(row.byte_length),
    pdfBytes: Buffer.isBuffer(row.pdf_bytes) ? Buffer.from(row.pdf_bytes) : null,
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
    throw new QualifiedInvoiceDocumentError('INVALID_QUALIFIED_PDF_BYTES', 500);
  }
  return pdf;
}

function createQualifiedInvoiceDocumentStore({
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
      throw new QualifiedInvoiceDocumentError('INVALID_QUALIFIED_DOCUMENT_LOOKUP');
    }
    const issuedInvoiceId = uuid(input.issuedInvoiceId, 'INVALID_ISSUED_INVOICE_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_qualified_invoice_documents
        WHERE business_id=$1 AND issued_invoice_id=$2`,
      [tenant, issuedInvoiceId]
    );
    if (!found.rows.length) {
      throw new QualifiedInvoiceDocumentError('QUALIFIED_DOCUMENT_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  async function materialize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'bindingId') {
      throw new QualifiedInvoiceDocumentError('INVALID_QUALIFIED_DOCUMENT_REQUEST');
    }
    const bindingId = uuid(input.bindingId, 'INVALID_BINDING_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const chain = await client.query(
        `SELECT
            b.id AS binding_id,b.issued_invoice_id,b.issuer_profile_id,
            b.issuer_profile_hash AS binding_profile_hash,
            b.issuer_profile_version AS binding_profile_version,
            i.authorization_id,i.draft_id,i.attempt_id,i.provider,i.provider_invoice_id,
            i.official_invoice_number,i.issued_snapshot,i.status AS invoice_status,
            i.delivery_state AS invoice_delivery_state,i.provider_confirmed_at,
            i.materialized_at AS invoice_materialized_at,
            p.profile_version,p.legal_name,p.display_name,p.address_lines,p.city,p.region,
            p.postal_code,p.country_code,p.contact_email,p.contact_phone,p.tax_registrations,
            p.profile_hash,p.state AS profile_state,
            d.id AS source_document_id,d.content_sha256 AS source_document_sha256,
            d.delivery_state AS source_delivery_state
           FROM facturations_invoice_issuer_bindings AS b
           JOIN facturations_issued_invoices AS i
             ON i.business_id=b.business_id AND i.id=b.issued_invoice_id
           JOIN facturations_issuer_profiles AS p
             ON p.business_id=b.business_id AND p.id=b.issuer_profile_id
           JOIN facturations_issued_invoice_documents AS d
             ON d.business_id=b.business_id AND d.issued_invoice_id=b.issued_invoice_id
          WHERE b.business_id=$1 AND b.id=$2
          FOR SHARE OF b,i,p,d`,
        [tenant, bindingId]
      );
      if (!chain.rows.length) {
        throw new QualifiedInvoiceDocumentError('QUALIFIED_DOCUMENT_CHAIN_NOT_FOUND', 404);
      }
      const row = chain.rows[0];

      if (row.invoice_status !== 'ISSUED_CONFIRMED' ||
          row.invoice_delivery_state !== 'NOT_AUTHORIZED' ||
          row.profile_state !== 'VERIFIED' ||
          row.source_delivery_state !== 'NOT_AUTHORIZED') {
        throw new QualifiedInvoiceDocumentError('QUALIFIED_DOCUMENT_CHAIN_NOT_READY', 409);
      }
      if (row.binding_profile_hash !== row.profile_hash ||
          Number(row.binding_profile_version) !== Number(row.profile_version)) {
        throw new QualifiedInvoiceDocumentError('ISSUER_PROFILE_PROVENANCE_MISMATCH', 409);
      }
      if (Number(row.issued_snapshot?.taxTotalCents) > 0 &&
          (!Array.isArray(row.tax_registrations) || row.tax_registrations.length < 1)) {
        throw new QualifiedInvoiceDocumentError('TAX_REGISTRATION_EVIDENCE_REQUIRED', 409);
      }

      let pdf;
      try {
        pdf = validatePdf(await renderer(invoiceOf(row), profileOf(row)));
      } catch (error) {
        if (error instanceof QualifiedInvoiceDocumentError) throw error;
        if (error && typeof error.code === 'string') {
          throw new QualifiedInvoiceDocumentError(error.code, error.statusCode || 422);
        }
        throw new QualifiedInvoiceDocumentError('QUALIFIED_PDF_RENDER_FAILED', 500);
      }
      const hash = crypto.createHash('sha256').update(pdf).digest('hex');

      const inserted = await client.query(
        `INSERT INTO facturations_qualified_invoice_documents
           (business_id,binding_id,issued_invoice_id,source_document_id,
            source_document_sha256,issuer_profile_id,issuer_profile_hash,
            issuer_profile_version,render_version,content_sha256,byte_length,pdf_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          tenant,
          row.binding_id,
          row.issued_invoice_id,
          row.source_document_id,
          row.source_document_sha256,
          row.issuer_profile_id,
          row.profile_hash,
          row.profile_version,
          RENDER_VERSION,
          hash,
          pdf.length,
          pdf,
        ]
      );
      let saved = inserted.rows[0];

      if (!saved) {
        const prior = await client.query(
          `SELECT * FROM facturations_qualified_invoice_documents
            WHERE business_id=$1 AND issued_invoice_id=$2`,
          [tenant, row.issued_invoice_id]
        );
        saved = prior.rows[0];
        if (!saved ||
            saved.binding_id !== row.binding_id ||
            saved.source_document_id !== row.source_document_id ||
            saved.source_document_sha256 !== row.source_document_sha256 ||
            saved.issuer_profile_id !== row.issuer_profile_id ||
            saved.issuer_profile_hash !== row.profile_hash ||
            Number(saved.issuer_profile_version) !== Number(row.profile_version) ||
            saved.render_version !== RENDER_VERSION ||
            saved.content_sha256 !== hash ||
            Number(saved.byte_length) !== pdf.length ||
            saved.delivery_state !== 'NOT_AUTHORIZED' ||
            !Buffer.isBuffer(saved.pdf_bytes) ||
            !saved.pdf_bytes.equals(pdf)) {
          throw new QualifiedInvoiceDocumentError('QUALIFIED_DOCUMENT_CONFLICT', 409);
        }
      }

      await client.query('COMMIT');
      transaction = false;
      return resultOf(saved);
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
  createQualifiedInvoiceDocumentStore,
  QualifiedInvoiceDocumentError,
  QUALIFIED_INVOICE_PDF_RENDER_VERSION: RENDER_VERSION,
};
