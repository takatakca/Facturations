'use strict';

const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const PROVIDER = 'WAVE';

class ProviderExecutionError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ProviderExecutionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProviderExecutionError(code);
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) {
    throw new ProviderExecutionError('INVALID_VERSION');
  }
  return value;
}
function optionalText(value, code, max) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max ||
      !SAFE_TEXT.test(value.trim())) throw new ProviderExecutionError(code);
  return value.trim();
}
function asResult(row) {
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    provider: row.provider,
    operationKey: row.operation_key,
    state: row.state,
    version: row.version,
    providerInvoiceId: row.provider_invoice_id,
    officialInvoiceNumber: row.official_invoice_number,
    errorCode: row.error_code,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at,
    reconciledAt: row.reconciled_at instanceof Date ? row.reconciled_at.toISOString() : row.reconciled_at,
  });
}
function assertExactKeys(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) {
    throw new ProviderExecutionError(code);
  }
}
function validatePrepare(input) {
  assertExactKeys(input, ['authorizationId','draftId','provider'], 'INVALID_PREPARE');
  if (input.provider !== PROVIDER) throw new ProviderExecutionError('INVALID_PROVIDER');
  return Object.freeze({
    authorizationId: uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID'),
    draftId: uuid(input.draftId, 'INVALID_DRAFT_ID'),
    provider: input.provider,
  });
}
function validateExecutionId(input) {
  assertExactKeys(input, ['executionId','expectedVersion'], 'INVALID_TRANSITION');
  return Object.freeze({
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
    expectedVersion: version(input.expectedVersion),
  });
}
function validateOutcome(input) {
  assertExactKeys(input, ['executionId','expectedVersion','outcome','providerInvoiceId',
    'officialInvoiceNumber','errorCode'], 'INVALID_OUTCOME');
  const base = {
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
    expectedVersion: version(input.expectedVersion),
  };
  if (!['CONFIRMED','AMBIGUOUS','FAILED_RETRYABLE','FAILED_FINAL'].includes(input.outcome)) {
    throw new ProviderExecutionError('INVALID_OUTCOME');
  }
  const providerInvoiceId = optionalText(input.providerInvoiceId, 'INVALID_PROVIDER_INVOICE_ID', 512);
  const officialInvoiceNumber = optionalText(input.officialInvoiceNumber, 'INVALID_OFFICIAL_NUMBER', 160);
  const errorCode = optionalText(input.errorCode, 'INVALID_ERROR_CODE', 160);
  if (input.outcome === 'CONFIRMED') {
    if (!providerInvoiceId || !officialInvoiceNumber || errorCode !== null) {
      throw new ProviderExecutionError('CONFIRMED_DETAILS_REQUIRED');
    }
  } else if (providerInvoiceId !== null || officialInvoiceNumber !== null || errorCode === null) {
    throw new ProviderExecutionError('FAILURE_DETAILS_REQUIRED');
  }
  return Object.freeze({ ...base, outcome: input.outcome, providerInvoiceId,
    officialInvoiceNumber, errorCode });
}
function validateReconciliation(input) {
  assertExactKeys(input, ['executionId','expectedVersion','resolution','providerInvoiceId',
    'officialInvoiceNumber','errorCode'], 'INVALID_RECONCILIATION');
  const base = {
    executionId: uuid(input.executionId, 'INVALID_EXECUTION_ID'),
    expectedVersion: version(input.expectedVersion),
  };
  if (!['CONFIRMED','NOT_FOUND_RETRYABLE','FAILED_FINAL'].includes(input.resolution)) {
    throw new ProviderExecutionError('INVALID_RECONCILIATION');
  }
  const providerInvoiceId = optionalText(input.providerInvoiceId, 'INVALID_PROVIDER_INVOICE_ID', 512);
  const officialInvoiceNumber = optionalText(input.officialInvoiceNumber, 'INVALID_OFFICIAL_NUMBER', 160);
  const errorCode = optionalText(input.errorCode, 'INVALID_ERROR_CODE', 160);
  if (input.resolution === 'CONFIRMED') {
    if (!providerInvoiceId || !officialInvoiceNumber || errorCode !== null) {
      throw new ProviderExecutionError('CONFIRMED_DETAILS_REQUIRED');
    }
  } else if (providerInvoiceId !== null || officialInvoiceNumber !== null || errorCode === null) {
    throw new ProviderExecutionError('RECONCILIATION_DETAILS_REQUIRED');
  }
  return Object.freeze({ ...base, resolution: input.resolution, providerInvoiceId,
    officialInvoiceNumber, errorCode });
}

function createProviderExecutionStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function get(executionId) {
    uuid(executionId, 'INVALID_EXECUTION_ID');
    const result = await pool.query(
      `SELECT id,authorization_id,draft_id,provider,operation_key,state,version,
              provider_invoice_id,official_invoice_number,error_code,
              created_at,started_at,finished_at,reconciled_at
         FROM facturations_provider_executions
        WHERE business_id=$1 AND id=$2`,
      [tenant, executionId]
    );
    if (!result.rows.length) throw new ProviderExecutionError('EXECUTION_NOT_FOUND', 404);
    return asResult(result.rows[0]);
  }

  async function prepare(input) {
    const fields = validatePrepare(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const authorization = await client.query(
        `SELECT a.id,a.draft_id,a.provider,d.status
           FROM facturations_issuance_authorizations AS a
           JOIN invoice_drafts AS d
             ON d.business_id=a.business_id AND d.id=a.draft_id
          WHERE a.business_id=$1 AND a.id=$2
          FOR SHARE OF a,d`,
        [tenant, fields.authorizationId]
      );
      if (!authorization.rows.length) {
        throw new ProviderExecutionError('AUTHORIZATION_NOT_FOUND', 404);
      }
      const row = authorization.rows[0];
      if (row.draft_id !== fields.draftId || row.provider !== fields.provider ||
          row.status !== 'DRAFT') {
        throw new ProviderExecutionError('AUTHORIZATION_MISMATCH', 409);
      }
      const operationKey = crypto.randomBytes(32).toString('base64url');
      const inserted = await client.query(
        `INSERT INTO facturations_provider_executions
          (business_id,authorization_id,draft_id,provider,operation_key)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id,authorization_id) DO NOTHING
         RETURNING id,authorization_id,draft_id,provider,operation_key,state,version,
                   provider_invoice_id,official_invoice_number,error_code,
                   created_at,started_at,finished_at,reconciled_at`,
        [tenant, fields.authorizationId, fields.draftId, fields.provider, operationKey]
      );
      let execution = inserted.rows[0];
      if (!execution) {
        const prior = await client.query(
          `SELECT id,authorization_id,draft_id,provider,operation_key,state,version,
                  provider_invoice_id,official_invoice_number,error_code,
                  created_at,started_at,finished_at,reconciled_at
             FROM facturations_provider_executions
            WHERE business_id=$1 AND authorization_id=$2`,
          [tenant, fields.authorizationId]
        );
        execution = prior.rows[0];
        if (!execution || execution.draft_id !== fields.draftId ||
            execution.provider !== fields.provider) {
          throw new ProviderExecutionError('PREPARE_CONFLICT', 409);
        }
      }
      await client.query('COMMIT');
      transaction = false;
      return asResult(execution);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function begin(input) {
    const fields = validateExecutionId(input);
    const result = await pool.query(
      `UPDATE facturations_provider_executions
          SET state='IN_PROGRESS',version=version+1,started_at=now(),
              finished_at=NULL,error_code=NULL
        WHERE business_id=$1 AND id=$2 AND version=$3
          AND state IN ('PREPARED','FAILED_RETRYABLE')
        RETURNING id,authorization_id,draft_id,provider,operation_key,state,version,
                  provider_invoice_id,official_invoice_number,error_code,
                  created_at,started_at,finished_at,reconciled_at`,
      [tenant, fields.executionId, fields.expectedVersion]
    );
    if (!result.rows.length) {
      const current = await get(fields.executionId);
      if (current.version !== fields.expectedVersion) {
        throw new ProviderExecutionError('VERSION_CONFLICT', 409);
      }
      if (current.state === 'AMBIGUOUS') {
        throw new ProviderExecutionError('RECONCILIATION_REQUIRED', 409);
      }
      throw new ProviderExecutionError('INVALID_STATE_TRANSITION', 409);
    }
    return asResult(result.rows[0]);
  }

  async function recordOutcome(input) {
    const fields = validateOutcome(input);
    const result = await pool.query(
      `UPDATE facturations_provider_executions
          SET state=$4,version=version+1,
              provider_invoice_id=$5,official_invoice_number=$6,error_code=$7,
              finished_at=now()
        WHERE business_id=$1 AND id=$2 AND version=$3 AND state='IN_PROGRESS'
        RETURNING id,authorization_id,draft_id,provider,operation_key,state,version,
                  provider_invoice_id,official_invoice_number,error_code,
                  created_at,started_at,finished_at,reconciled_at`,
      [tenant, fields.executionId, fields.expectedVersion, fields.outcome,
        fields.providerInvoiceId, fields.officialInvoiceNumber, fields.errorCode]
    );
    if (!result.rows.length) {
      const current = await get(fields.executionId);
      if (current.version !== fields.expectedVersion) {
        throw new ProviderExecutionError('VERSION_CONFLICT', 409);
      }
      throw new ProviderExecutionError('INVALID_STATE_TRANSITION', 409);
    }
    return asResult(result.rows[0]);
  }

  async function reconcileAmbiguous(input) {
    const fields = validateReconciliation(input);
    const nextState = fields.resolution === 'CONFIRMED'
      ? 'CONFIRMED'
      : fields.resolution === 'NOT_FOUND_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const result = await pool.query(
      `UPDATE facturations_provider_executions
          SET state=$4,version=version+1,
              provider_invoice_id=$5,official_invoice_number=$6,error_code=$7,
              reconciled_at=now(),finished_at=COALESCE(finished_at,now())
        WHERE business_id=$1 AND id=$2 AND version=$3 AND state='AMBIGUOUS'
        RETURNING id,authorization_id,draft_id,provider,operation_key,state,version,
                  provider_invoice_id,official_invoice_number,error_code,
                  created_at,started_at,finished_at,reconciled_at`,
      [tenant, fields.executionId, fields.expectedVersion, nextState,
        fields.providerInvoiceId, fields.officialInvoiceNumber, fields.errorCode]
    );
    if (!result.rows.length) {
      const current = await get(fields.executionId);
      if (current.version !== fields.expectedVersion) {
        throw new ProviderExecutionError('VERSION_CONFLICT', 409);
      }
      throw new ProviderExecutionError('RECONCILIATION_NOT_ALLOWED', 409);
    }
    return asResult(result.rows[0]);
  }

  return Object.freeze({ prepare, begin, recordOutcome, reconcileAmbiguous, get });
}

module.exports = {
  createProviderExecutionStore,
  ProviderExecutionError,
};
