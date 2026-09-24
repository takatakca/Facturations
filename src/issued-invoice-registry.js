'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

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
  return value;
}

function safeText(value, max, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      !SAFE_TEXT.test(value)) {
    throw new IssuedInvoiceRegistryError(code);
  }
  return value;
}

function validateMaterialize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'authorizationId,draftId,executionId') {
    throw new IssuedInvoiceRegistryError('INVALID_ISSUED_INVOICE_REQUEST');
  }
  return Object.freeze({
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    draftId: uuid(input.draftId, 'INVALID_DRAFT_ID'),
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
  });
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    executionId: row.execution_id,
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

function createIssuedInvoiceRegistry({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getByDraft(draftId) {
    uuid(draftId, 'INVALID_DRAFT_ID');
    const found = await pool.query(
      `SELECT id,authorization_id,draft_id,execution_id,provider,provider_invoice_id,
              official_invoice_number,issued_snapshot,status,delivery_state,
              provider_confirmed_at,materialized_at
         FROM facturations_issued_invoices
        WHERE business_id=$1 AND draft_id=$2`,
      [tenant, draftId]
    );
    if (!found.rows.length) {
      throw new IssuedInvoiceRegistryError('ISSUED_INVOICE_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  async function materialize(input) {
    const fields = validateMaterialize(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;

      const chain = await client.query(
        `SELECT e.id AS execution_id,e.authorization_id,e.draft_id,e.provider,e.state,
                e.provider_invoice_id,e.official_invoice_number,e.finished_at,e.reconciled_at,
                a.id AS authorization_exists,d.request_hash,d.snapshot,
                c.provider_invoice_id AS create_provider_invoice_id
           FROM facturations_provider_executions AS e
           JOIN facturations_issuance_authorizations AS a
             ON a.business_id=e.business_id AND a.id=e.authorization_id
           JOIN invoice_drafts AS d
             ON d.business_id=e.business_id AND d.id=e.draft_id
           LEFT JOIN facturations_wave_create_confirmations AS c
             ON c.business_id=e.business_id AND c.execution_id=e.id
          WHERE e.business_id=$1 AND e.id=$2
          FOR SHARE OF e,a,d,c`,
        [tenant, fields.executionId]
      );
      if (!chain.rows.length) {
        throw new IssuedInvoiceRegistryError('CONFIRMED_EXECUTION_NOT_FOUND', 404);
      }
      const row = chain.rows[0];
      if (row.authorization_id !== fields.authorizationId ||
          row.draft_id !== fields.draftId ||
          row.provider !== 'WAVE' ||
          row.state !== 'CONFIRMED' ||
          typeof row.provider_invoice_id !== 'string' ||
          typeof row.official_invoice_number !== 'string' ||
          row.create_provider_invoice_id !== row.provider_invoice_id ||
          !row.finished_at) {
        throw new IssuedInvoiceRegistryError('ISSUANCE_CHAIN_NOT_CONFIRMED', 409);
      }
      safeText(row.provider_invoice_id, 512, 'INVALID_PROVIDER_INVOICE_ID');
      safeText(row.official_invoice_number, 160, 'INVALID_OFFICIAL_NUMBER');
      if (!row.snapshot || typeof row.snapshot !== 'object' || Array.isArray(row.snapshot) ||
          typeof row.request_hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.request_hash)) {
        throw new IssuedInvoiceRegistryError('INVALID_CONFIRMED_SNAPSHOT', 409);
      }
      const providerConfirmedAt = row.reconciled_at || row.finished_at;

      const inserted = await client.query(
        `INSERT INTO facturations_issued_invoices
          (business_id,authorization_id,draft_id,execution_id,provider,
           provider_invoice_id,official_invoice_number,request_hash,issued_snapshot,
           provider_confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (business_id,draft_id) DO NOTHING
         RETURNING id,authorization_id,draft_id,execution_id,provider,provider_invoice_id,
                   official_invoice_number,issued_snapshot,status,delivery_state,
                   provider_confirmed_at,materialized_at`,
        [tenant, fields.authorizationId, fields.draftId, fields.executionId, 'WAVE',
          row.provider_invoice_id, row.official_invoice_number, row.request_hash,
          JSON.stringify(row.snapshot), providerConfirmedAt]
      );
      let stored = inserted.rows[0];
      if (!stored) {
        const prior = await client.query(
          `SELECT id,authorization_id,draft_id,execution_id,provider,provider_invoice_id,
                  official_invoice_number,request_hash,issued_snapshot,status,delivery_state,
                  provider_confirmed_at,materialized_at,
                  (issued_snapshot = $3::jsonb) AS snapshot_matches
             FROM facturations_issued_invoices
            WHERE business_id=$1 AND draft_id=$2`,
          [tenant, fields.draftId, JSON.stringify(row.snapshot)]
        );
        stored = prior.rows[0];
        if (!stored ||
            stored.authorization_id !== fields.authorizationId ||
            stored.execution_id !== fields.executionId ||
            stored.provider !== 'WAVE' ||
            stored.provider_invoice_id !== row.provider_invoice_id ||
            stored.official_invoice_number !== row.official_invoice_number ||
            stored.request_hash !== row.request_hash ||
            stored.snapshot_matches !== true) {
          throw new IssuedInvoiceRegistryError('ISSUED_INVOICE_CONFLICT', 409);
        }
      }
      await client.query('COMMIT');
      transaction = false;
      return resultOf(stored);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ materialize, getByDraft });
}

module.exports = {
  createIssuedInvoiceRegistry,
  IssuedInvoiceRegistryError,
};
