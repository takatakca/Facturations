'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,80}$/;
const PROVIDER = 'WAVE';
const OUTCOMES = new Set(['CONFIRMED', 'AMBIGUOUS', 'FAILED_RETRYABLE', 'FAILED_FINAL']);
const RESOLUTIONS = new Set(['CONFIRMED_EXISTING', 'NOT_FOUND']);

class ProviderIssuanceError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ProviderIssuanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function id(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProviderIssuanceError(code);
  return value.toLowerCase();
}
function boundedExternal(value, code, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProviderIssuanceError(code);
  }
  return value;
}
function validateBegin(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'attemptKey,authorizationId,provider') {
    throw new ProviderIssuanceError('INVALID_ATTEMPT');
  }
  if (input.provider !== PROVIDER) throw new ProviderIssuanceError('INVALID_PROVIDER');
  if (typeof input.attemptKey !== 'string' || !KEY.test(input.attemptKey)) {
    throw new ProviderIssuanceError('INVALID_ATTEMPT_KEY');
  }
  return Object.freeze({
    authorizationId: id(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    attemptKey: input.attemptKey,
    provider: input.provider,
  });
}
function validateOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'attemptId,outcome,providerInvoiceId,providerInvoiceNumber') {
    throw new ProviderIssuanceError('INVALID_OUTCOME');
  }
  const attemptId = id(input.attemptId, 'INVALID_ATTEMPT_ID');
  if (!OUTCOMES.has(input.outcome)) throw new ProviderIssuanceError('INVALID_OUTCOME');
  if (input.outcome === 'CONFIRMED') {
    return Object.freeze({
      attemptId,
      outcome: input.outcome,
      providerInvoiceId: boundedExternal(input.providerInvoiceId, 'INVALID_PROVIDER_INVOICE_ID', 200),
      providerInvoiceNumber: boundedExternal(input.providerInvoiceNumber, 'INVALID_PROVIDER_INVOICE_NUMBER', 120),
    });
  }
  if (input.providerInvoiceId !== null || input.providerInvoiceNumber !== null) {
    throw new ProviderIssuanceError('UNCONFIRMED_PROVIDER_ID_FORBIDDEN');
  }
  return Object.freeze({ attemptId, outcome: input.outcome,
    providerInvoiceId: null, providerInvoiceNumber: null });
}
function validateReconciliation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'attemptId,providerInvoiceId,providerInvoiceNumber,resolution') {
    throw new ProviderIssuanceError('INVALID_RECONCILIATION');
  }
  const attemptId = id(input.attemptId, 'INVALID_ATTEMPT_ID');
  if (!RESOLUTIONS.has(input.resolution)) throw new ProviderIssuanceError('INVALID_RECONCILIATION');
  if (input.resolution === 'CONFIRMED_EXISTING') {
    return Object.freeze({
      attemptId,
      resolution: input.resolution,
      providerInvoiceId: boundedExternal(input.providerInvoiceId, 'INVALID_PROVIDER_INVOICE_ID', 200),
      providerInvoiceNumber: boundedExternal(input.providerInvoiceNumber, 'INVALID_PROVIDER_INVOICE_NUMBER', 120),
    });
  }
  if (input.providerInvoiceId !== null || input.providerInvoiceNumber !== null) {
    throw new ProviderIssuanceError('NOT_FOUND_PROVIDER_ID_FORBIDDEN');
  }
  return Object.freeze({ attemptId, resolution: input.resolution,
    providerInvoiceId: null, providerInvoiceNumber: null });
}

function attemptResult(row, created) {
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    provider: row.provider,
    attemptKey: row.attempt_key,
    status: 'PROVIDER_ATTEMPT_STARTED',
    created,
    externalCallPerformed: false,
    issued: false,
    emailed: false,
  });
}
function outcomeResult(row) {
  return Object.freeze({
    id: row.id,
    attemptId: row.attempt_id,
    outcome: row.outcome,
    providerInvoiceId: row.provider_invoice_id,
    providerInvoiceNumber: row.provider_invoice_number,
    externalCallPerformedByStore: false,
  });
}
function reconciliationResult(row) {
  return Object.freeze({
    id: row.id,
    attemptId: row.attempt_id,
    resolution: row.resolution,
    providerInvoiceId: row.provider_invoice_id,
    providerInvoiceNumber: row.provider_invoice_number,
    externalCallPerformedByStore: false,
  });
}

function createProviderIssuanceStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function beginAttempt(input) {
    const fields = validateBegin(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const authorized = await client.query(
        `SELECT a.id,a.draft_id,a.state,d.status AS draft_status
           FROM facturations_issuance_authorizations AS a
           JOIN invoice_drafts AS d
             ON d.business_id=a.business_id AND d.id=a.draft_id
          WHERE a.business_id=$1 AND a.id=$2
          FOR UPDATE OF a`,
        [tenant, fields.authorizationId]
      );
      if (!authorized.rows.length) throw new ProviderIssuanceError('AUTHORIZATION_NOT_FOUND', 404);
      if (authorized.rows[0].state !== 'AUTHORIZED_PENDING_PROVIDER' ||
          authorized.rows[0].draft_status !== 'DRAFT') {
        throw new ProviderIssuanceError('AUTHORIZATION_NOT_EXECUTABLE', 409);
      }

      const exact = await client.query(
        `SELECT id,authorization_id,draft_id,provider,attempt_key,started_at
           FROM facturations_provider_issuance_attempts
          WHERE business_id=$1 AND authorization_id=$2 AND attempt_key=$3`,
        [tenant, fields.authorizationId, fields.attemptKey]
      );
      if (exact.rows.length) {
        await client.query('COMMIT'); transaction = false;
        return attemptResult(exact.rows[0], false);
      }

      const latest = await client.query(
        `SELECT a.id,r.outcome,x.resolution
           FROM facturations_provider_issuance_attempts AS a
           LEFT JOIN facturations_provider_issuance_results AS r
             ON r.business_id=a.business_id AND r.attempt_id=a.id
           LEFT JOIN facturations_provider_issuance_reconciliations AS x
             ON x.business_id=a.business_id AND x.attempt_id=a.id
          WHERE a.business_id=$1 AND a.authorization_id=$2
          ORDER BY a.started_at DESC,a.id DESC
          LIMIT 1`,
        [tenant, fields.authorizationId]
      );
      const prior = latest.rows[0];
      if (prior) {
        if (!prior.outcome) throw new ProviderIssuanceError('ATTEMPT_IN_FLIGHT', 409);
        if (prior.outcome === 'CONFIRMED') throw new ProviderIssuanceError('ALREADY_CONFIRMED', 409);
        if (prior.outcome === 'FAILED_FINAL') throw new ProviderIssuanceError('FINAL_FAILURE', 409);
        if (prior.outcome === 'AMBIGUOUS') {
          if (!prior.resolution) throw new ProviderIssuanceError('RECONCILIATION_REQUIRED', 409);
          if (prior.resolution === 'CONFIRMED_EXISTING') {
            throw new ProviderIssuanceError('ALREADY_CONFIRMED', 409);
          }
          if (prior.resolution !== 'NOT_FOUND') {
            throw new ProviderIssuanceError('RECONCILIATION_REQUIRED', 409);
          }
        }
      }

      const inserted = await client.query(
        `INSERT INTO facturations_provider_issuance_attempts
          (business_id,authorization_id,draft_id,provider,attempt_key)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id,authorization_id,draft_id,provider,attempt_key,started_at`,
        [tenant, fields.authorizationId, authorized.rows[0].draft_id, fields.provider, fields.attemptKey]
      );
      await client.query('COMMIT'); transaction = false;
      return attemptResult(inserted.rows[0], true);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      if (error?.code === '23505') throw new ProviderIssuanceError('ATTEMPT_CONFLICT', 409);
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordOutcome(input) {
    const fields = validateOutcome(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN'); transaction = true;
      const attempt = await client.query(
        `SELECT id FROM facturations_provider_issuance_attempts
          WHERE business_id=$1 AND id=$2 FOR SHARE`,
        [tenant, fields.attemptId]
      );
      if (!attempt.rows.length) throw new ProviderIssuanceError('ATTEMPT_NOT_FOUND', 404);
      const inserted = await client.query(
        `INSERT INTO facturations_provider_issuance_results
          (business_id,attempt_id,outcome,provider_invoice_id,provider_invoice_number)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id,attempt_id) DO NOTHING
         RETURNING id,attempt_id,outcome,provider_invoice_id,provider_invoice_number,recorded_at`,
        [tenant, fields.attemptId, fields.outcome, fields.providerInvoiceId, fields.providerInvoiceNumber]
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query(
          `SELECT id,attempt_id,outcome,provider_invoice_id,provider_invoice_number,recorded_at
             FROM facturations_provider_issuance_results
            WHERE business_id=$1 AND attempt_id=$2`,
          [tenant, fields.attemptId]
        );
        row = existing.rows[0];
        if (!row || row.outcome !== fields.outcome ||
            row.provider_invoice_id !== fields.providerInvoiceId ||
            row.provider_invoice_number !== fields.providerInvoiceNumber) {
          throw new ProviderIssuanceError('OUTCOME_CONFLICT', 409);
        }
      }
      await client.query('COMMIT'); transaction = false;
      return outcomeResult(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordReconciliation(input) {
    const fields = validateReconciliation(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN'); transaction = true;
      const attempt = await client.query(
        `SELECT a.id,r.outcome
           FROM facturations_provider_issuance_attempts AS a
           JOIN facturations_provider_issuance_results AS r
             ON r.business_id=a.business_id AND r.attempt_id=a.id
          WHERE a.business_id=$1 AND a.id=$2
          FOR SHARE OF a,r`,
        [tenant, fields.attemptId]
      );
      if (!attempt.rows.length) throw new ProviderIssuanceError('ATTEMPT_NOT_FOUND', 404);
      if (attempt.rows[0].outcome !== 'AMBIGUOUS') {
        throw new ProviderIssuanceError('AMBIGUOUS_RESULT_REQUIRED', 409);
      }
      const inserted = await client.query(
        `INSERT INTO facturations_provider_issuance_reconciliations
          (business_id,attempt_id,resolution,provider_invoice_id,provider_invoice_number)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id,attempt_id) DO NOTHING
         RETURNING id,attempt_id,resolution,provider_invoice_id,provider_invoice_number,checked_at`,
        [tenant, fields.attemptId, fields.resolution,
          fields.providerInvoiceId, fields.providerInvoiceNumber]
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query(
          `SELECT id,attempt_id,resolution,provider_invoice_id,provider_invoice_number,checked_at
             FROM facturations_provider_issuance_reconciliations
            WHERE business_id=$1 AND attempt_id=$2`,
          [tenant, fields.attemptId]
        );
        row = existing.rows[0];
        if (!row || row.resolution !== fields.resolution ||
            row.provider_invoice_id !== fields.providerInvoiceId ||
            row.provider_invoice_number !== fields.providerInvoiceNumber) {
          throw new ProviderIssuanceError('RECONCILIATION_CONFLICT', 409);
        }
      }
      await client.query('COMMIT'); transaction = false;
      return reconciliationResult(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getExecutionState({ authorizationId }) {
    const authorization = id(authorizationId, 'INVALID_AUTHORIZATION_ID');
    const found = await pool.query(
      `SELECT a.id AS attempt_id,a.attempt_key,a.started_at,
              r.outcome,r.provider_invoice_id,r.provider_invoice_number,r.recorded_at,
              x.resolution,x.provider_invoice_id AS reconciled_invoice_id,
              x.provider_invoice_number AS reconciled_invoice_number,x.checked_at
         FROM facturations_provider_issuance_attempts AS a
         LEFT JOIN facturations_provider_issuance_results AS r
           ON r.business_id=a.business_id AND r.attempt_id=a.id
         LEFT JOIN facturations_provider_issuance_reconciliations AS x
           ON x.business_id=a.business_id AND x.attempt_id=a.id
        WHERE a.business_id=$1 AND a.authorization_id=$2
        ORDER BY a.started_at ASC,a.id ASC`,
      [tenant, authorization]
    );
    return Object.freeze({
      authorizationId: authorization,
      provider: PROVIDER,
      attempts: Object.freeze(found.rows.map(row => Object.freeze({
        id: row.attempt_id,
        attemptKey: row.attempt_key,
        outcome: row.outcome || null,
        providerInvoiceId: row.provider_invoice_id || null,
        providerInvoiceNumber: row.provider_invoice_number || null,
        reconciliation: row.resolution || null,
        reconciledInvoiceId: row.reconciled_invoice_id || null,
        reconciledInvoiceNumber: row.reconciled_invoice_number || null,
      }))),
    });
  }

  return Object.freeze({ beginAttempt, recordOutcome, recordReconciliation, getExecutionState });
}

module.exports = {
  createProviderIssuanceStore,
  ProviderIssuanceError,
  validateProviderAttempt: validateBegin,
  validateProviderOutcome: validateOutcome,
  validateProviderReconciliation: validateReconciliation,
};
