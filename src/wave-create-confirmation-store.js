'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

class WaveCreateConfirmationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveCreateConfirmationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new WaveCreateConfirmationError(code);
  }
  return value;
}

function text(value, max, code) {
  if (typeof value !== 'string' || value.trim().length < 1 ||
      value.trim().length > max || !SAFE_TEXT.test(value.trim())) {
    throw new WaveCreateConfirmationError(code);
  }
  return value.trim();
}

function optionalText(value, max, code) {
  if (value === null) return null;
  return text(value, max, code);
}

function validateSave(input, reconciled = false) {
  const keys = reconciled
    ? 'authorizationId,confirmation,draftId,executionId,providerInvoiceId,providerInvoiceNumber'
    : 'authorizationId,draftId,executionId,providerInvoiceId,providerInvoiceNumber';
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== keys) {
    throw new WaveCreateConfirmationError('INVALID_CREATE_CONFIRMATION');
  }
  if (reconciled && input.confirmation !== 'READ_ONLY_RECONCILIATION_MATCH') {
    throw new WaveCreateConfirmationError('RECONCILIATION_CONFIRMATION_REQUIRED');
  }
  return Object.freeze({
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    draftId: uuid(input.draftId, 'INVALID_DRAFT_ID'),
    providerInvoiceId: text(input.providerInvoiceId, 512, 'INVALID_PROVIDER_INVOICE_ID'),
    providerInvoiceNumber: optionalText(
      input.providerInvoiceNumber, 160, 'INVALID_PROVIDER_INVOICE_NUMBER'),
  });
}

function resultOf(row) {
  return Object.freeze({
    id: row.id,
    executionId: row.execution_id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    providerInvoiceId: row.provider_invoice_id,
    providerInvoiceNumber: row.provider_invoice_number,
    confirmedAt: row.confirmed_at instanceof Date
      ? row.confirmed_at.toISOString()
      : row.confirmed_at,
  });
}

function createWaveCreateConfirmationStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() ||
      businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function getByExecution(executionId) {
    uuid(executionId, 'INVALID_EXECUTION_ID');
    const found = await pool.query(
      `SELECT id,execution_id,authorization_id,draft_id,
              provider_invoice_id,provider_invoice_number,confirmed_at
         FROM facturations_wave_create_confirmations
        WHERE business_id=$1 AND execution_id=$2`,
      [tenant, executionId]
    );
    if (!found.rows.length) {
      throw new WaveCreateConfirmationError('CREATE_CONFIRMATION_NOT_FOUND', 404);
    }
    return resultOf(found.rows[0]);
  }

  async function saveForState(input, state, reconciled) {
    const fields = validateSave(input, reconciled);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const execution = await client.query(
        `SELECT id,authorization_id,draft_id,provider,state
           FROM facturations_provider_executions
          WHERE business_id=$1 AND id=$2
          FOR SHARE`,
        [tenant, fields.executionId]
      );
      if (!execution.rows.length) {
        throw new WaveCreateConfirmationError('EXECUTION_NOT_FOUND', 404);
      }
      const row = execution.rows[0];
      if (row.authorization_id !== fields.authorizationId ||
          row.draft_id !== fields.draftId ||
          row.provider !== 'WAVE' ||
          row.state !== state) {
        throw new WaveCreateConfirmationError('EXECUTION_CHAIN_MISMATCH', 409);
      }

      const inserted = await client.query(
        `INSERT INTO facturations_wave_create_confirmations
          (business_id,execution_id,authorization_id,draft_id,
           provider_invoice_id,provider_invoice_number)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (business_id,execution_id) DO NOTHING
         RETURNING id,execution_id,authorization_id,draft_id,
                   provider_invoice_id,provider_invoice_number,confirmed_at`,
        [tenant, fields.executionId, fields.authorizationId, fields.draftId,
          fields.providerInvoiceId, fields.providerInvoiceNumber]
      );
      let stored = inserted.rows[0];
      if (!stored) {
        const prior = await client.query(
          `SELECT id,execution_id,authorization_id,draft_id,
                  provider_invoice_id,provider_invoice_number,confirmed_at
             FROM facturations_wave_create_confirmations
            WHERE business_id=$1 AND execution_id=$2`,
          [tenant, fields.executionId]
        );
        stored = prior.rows[0];
        if (!stored ||
            stored.authorization_id !== fields.authorizationId ||
            stored.draft_id !== fields.draftId ||
            stored.provider_invoice_id !== fields.providerInvoiceId ||
            stored.provider_invoice_number !== fields.providerInvoiceNumber) {
          throw new WaveCreateConfirmationError('CREATE_CONFIRMATION_CONFLICT', 409);
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

  async function save(input) {
    return saveForState(input, 'IN_PROGRESS', false);
  }

  // Read-only reconciliation may prove that a CREATE succeeded after the
  // mutation response was lost. Persist that provider invoice only while the
  // execution is already AMBIGUOUS; this never performs a provider mutation.
  async function saveReconciled(input) {
    return saveForState(input, 'AMBIGUOUS', true);
  }

  return Object.freeze({ save, saveReconciled, getByExecution });
}

module.exports = {
  createWaveCreateConfirmationStore,
  WaveCreateConfirmationError,
};
