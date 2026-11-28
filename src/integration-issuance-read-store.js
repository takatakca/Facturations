'use strict';

// Read-only issuance status for the TAKATAK integration: given a draft id,
// returns the issued invoice materialized from it (if any) and its derived
// financial state. Business-scoped, never writes, never exposes customer
// contact data, provider payloads, hashes or snapshots.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES = new Set([
  'NO_EVIDENCE', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERPAID',
  'FULLY_REFUNDED', 'REFUND_EXCEEDS_PAYMENTS',
]);
const SCOPES = new Set(['NONE', 'SYNTHETIC_ONLY', 'VERIFIED_PROVIDER_PRESENT']);

class IssuanceReadError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuanceReadError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function unsignedString(value, code) {
  const text = String(value);
  if (!/^[0-9]{1,16}$/u.test(text)) throw new IssuanceReadError(code, 503);
  return text;
}

function toResult(row) {
  if (!row) return null;
  if (!STATES.has(row.financial_state) || !SCOPES.has(row.proof_scope) || row.currency !== 'CAD') {
    throw new IssuanceReadError('ISSUANCE_STORAGE_INVALID', 503);
  }
  return Object.freeze({
    id: row.id,
    officialInvoiceNumber: row.official_invoice_number,
    provider: row.provider,
    issuedAt: row.provider_confirmed_at instanceof Date
      ? row.provider_confirmed_at.toISOString() : String(row.provider_confirmed_at),
    currency: 'CAD',
    totalCents: unsignedString(row.total_cents, 'INVALID_TOTAL'),
    balanceCents: unsignedString(Math.max(0, Number(row.balance_cents)), 'INVALID_BALANCE'),
    financialState: row.financial_state,
    proofScope: row.proof_scope,
  });
}

function createIntegrationIssuanceReadStore({ pool, businessId } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Dedicated PostgreSQL pool required');
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getIssuanceByDraftId(draftId) {
    if (typeof draftId !== 'string' || !UUID.test(draftId)) {
      throw new IssuanceReadError('INVALID_DRAFT_ID');
    }
    const draft = await pool.query(
      'SELECT id FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [tenant, draftId.toLowerCase()]
    );
    if (!draft.rows.length) throw new IssuanceReadError('NOT_FOUND', 404);
    const found = await pool.query(
      `SELECT i.id, i.official_invoice_number, i.provider, i.provider_confirmed_at,
              i.issued_snapshot->>'currency' AS currency,
              s.invoice_total_cents AS total_cents, s.balance_cents,
              s.financial_state, s.proof_scope
         FROM facturations_issued_invoices AS i
         JOIN facturations_payment_evidence_summary AS s
           ON s.business_id=i.business_id AND s.issued_invoice_id=i.id
        WHERE i.business_id=$1 AND i.draft_id=$2`,
      [tenant, draftId.toLowerCase()]
    );
    return toResult(found.rows[0]);
  }

  return Object.freeze({ getIssuanceByDraftId });
}

module.exports = { createIntegrationIssuanceReadStore, IssuanceReadError };
