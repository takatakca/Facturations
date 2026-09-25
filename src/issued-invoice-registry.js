'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class IssuedInvoiceRegistryError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'IssuedInvoiceRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new IssuedInvoiceRegistryError(code);
  }
  return value.toLowerCase();
}

function asResult(row) {
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
    issued: true,
    providerConfirmed: true,
    deliveryAuthorized: false,
    emailed: false,
  });
}

function createIssuedInvoiceRegistry({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getByAttempt(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') {
      throw new IssuedInvoiceRegistryError('INVALID_ISSUED_INVOICE_LOOKUP');
    }
    const attemptId = uuid(input.attemptId, 'INVALID_ATTEMPT_ID');
    const found = await pool.query(
      `SELECT * FROM facturations_issued_invoices
        WHERE business_id=$1 AND attempt_id=$2`,
      [tenant, attemptId]
    );
    if (!found.rows.length) {
      throw new IssuedInvoiceRegistryError('ISSUED_INVOICE_NOT_FOUND', 404);
    }
    return asResult(found.rows[0]);
  }

  async function materialize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') {
      throw new IssuedInvoiceRegistryError('INVALID_MATERIALIZATION_REQUEST');
    }
    const attemptId = uuid(input.attemptId, 'INVALID_ATTEMPT_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const attemptResult = await client.query(
        `SELECT id,authorization_id,draft_id,provider,state,provider_invoice_id,
                provider_invoice_number,finished_at
           FROM facturations_provider_issuance_attempts
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant, attemptId]
      );
      if (!attemptResult.rows.length) {
        throw new IssuedInvoiceRegistryError('ATTEMPT_NOT_FOUND', 404);
      }
      const attempt = attemptResult.rows[0];
      if (attempt.state !== 'CONFIRMED' || !attempt.provider_invoice_id ||
          !attempt.provider_invoice_number || !attempt.finished_at) {
        throw new IssuedInvoiceRegistryError('PROVIDER_CONFIRMATION_REQUIRED', 409);
      }
      if (attempt.provider !== 'WAVE') {
        throw new IssuedInvoiceRegistryError('PROVIDER_MISMATCH', 409);
      }

      const chainResult = await client.query(
        `SELECT a.id AS authorization_id,a.draft_id,a.request_hash AS authorization_request_hash,
                a.expected_total_cents,a.expected_customer_email,a.provider,a.state AS authorization_state,
                d.request_hash AS draft_request_hash,d.snapshot,d.status AS draft_status
           FROM facturations_issuance_authorizations AS a
           JOIN invoice_drafts AS d
             ON d.business_id=a.business_id AND d.id=a.draft_id
          WHERE a.business_id=$1 AND a.id=$2 AND a.draft_id=$3
          FOR SHARE OF a,d`,
        [tenant, attempt.authorization_id, attempt.draft_id]
      );
      if (!chainResult.rows.length) {
        throw new IssuedInvoiceRegistryError('ISSUANCE_CHAIN_MISMATCH', 409);
      }
      const chain = chainResult.rows[0];
      if (chain.authorization_state !== 'AUTHORIZED_PENDING_PROVIDER' ||
          chain.draft_status !== 'DRAFT' || chain.provider !== attempt.provider ||
          chain.authorization_request_hash !== chain.draft_request_hash) {
        throw new IssuedInvoiceRegistryError('ISSUANCE_CHAIN_MISMATCH', 409);
      }
      if (Number(chain.expected_total_cents) !== chain.snapshot?.totalCents ||
          typeof chain.snapshot?.customer?.email !== 'string' ||
          chain.expected_customer_email !== chain.snapshot.customer.email.toLowerCase()) {
        throw new IssuedInvoiceRegistryError('ISSUANCE_DETAILS_MISMATCH', 409);
      }

      const inserted = await client.query(
        `INSERT INTO facturations_issued_invoices
           (business_id,authorization_id,draft_id,attempt_id,provider,
            provider_invoice_id,official_invoice_number,request_hash,
            issued_snapshot,provider_confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          tenant,
          attempt.authorization_id,
          attempt.draft_id,
          attempt.id,
          attempt.provider,
          attempt.provider_invoice_id,
          attempt.provider_invoice_number,
          chain.draft_request_hash,
          JSON.stringify(chain.snapshot),
          attempt.finished_at,
        ]
      );

      let row = inserted.rows[0];
      if (!row) {
        const prior = await client.query(
          `SELECT * FROM facturations_issued_invoices
            WHERE business_id=$1 AND (
              authorization_id=$2 OR draft_id=$3 OR attempt_id=$4 OR
              (provider=$5 AND provider_invoice_id=$6) OR
              (provider=$5 AND official_invoice_number=$7)
            )
            ORDER BY materialized_at,id`,
          [
            tenant,
            attempt.authorization_id,
            attempt.draft_id,
            attempt.id,
            attempt.provider,
            attempt.provider_invoice_id,
            attempt.provider_invoice_number,
          ]
        );
        if (prior.rows.length !== 1) {
          throw new IssuedInvoiceRegistryError('ISSUED_INVOICE_CONFLICT', 409);
        }
        row = prior.rows[0];
        if (row.authorization_id !== attempt.authorization_id ||
            row.draft_id !== attempt.draft_id ||
            row.attempt_id !== attempt.id ||
            row.provider !== attempt.provider ||
            row.provider_invoice_id !== attempt.provider_invoice_id ||
            row.official_invoice_number !== attempt.provider_invoice_number ||
            row.request_hash !== chain.draft_request_hash ||
            row.status !== 'ISSUED_CONFIRMED' ||
            row.delivery_state !== 'NOT_AUTHORIZED') {
          throw new IssuedInvoiceRegistryError('ISSUED_INVOICE_CONFLICT', 409);
        }
      }

      await client.query('COMMIT');
      transaction = false;
      return asResult(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ materialize, getByAttempt });
}

module.exports = {
  createIssuedInvoiceRegistry,
  IssuedInvoiceRegistryError,
};
