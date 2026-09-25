'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set(['PREPARED', 'IN_PROGRESS', 'AMBIGUOUS', 'CONFIRMED', 'FAILED']);

class ProviderIssuanceAttemptError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ProviderIssuanceAttemptError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ProviderIssuanceAttemptError(code);
  }
  return value.toLowerCase();
}

function providerText(value, code, max = 512) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProviderIssuanceAttemptError(code);
  }
  return value.trim();
}

function reason(value) {
  if (typeof value !== 'string' || !CODE.test(value)) {
    throw new ProviderIssuanceAttemptError('INVALID_OUTCOME_CODE');
  }
  return value;
}

function operationKey(tenant, authorizationId, requestHash) {
  return 'wave_' + crypto.createHash('sha256')
    .update('facturations-provider-operation-v1\0')
    .update(tenant).update('\0')
    .update(authorizationId).update('\0')
    .update(requestHash)
    .digest('base64url');
}

function asResult(row) {
  if (!row || !STATES.has(row.state)) throw new ProviderIssuanceAttemptError('STORAGE_UNAVAILABLE', 503);
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    draftId: row.draft_id,
    provider: row.provider,
    operationKey: row.operation_key,
    state: row.state,
    providerInvoiceId: row.provider_invoice_id || null,
    providerInvoiceNumber: row.provider_invoice_number || null,
    outcomeCode: row.outcome_code || null,
    preparedAt: row.prepared_at instanceof Date ? row.prepared_at.toISOString() : row.prepared_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at || null),
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : (row.finished_at || null),
    issued: false,
    waveSynced: false,
    emailed: false,
  });
}

function createProviderIssuanceAttemptStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function prepare(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'authorizationId') {
      throw new ProviderIssuanceAttemptError('INVALID_PREPARE_REQUEST');
    }
    const authorizationId = uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const authorized = await client.query(
        `SELECT a.id,a.draft_id,a.request_hash,a.expected_total_cents,
                a.expected_customer_email,a.provider,a.state,d.request_hash AS draft_request_hash,d.snapshot
           FROM facturations_issuance_authorizations AS a
           JOIN invoice_drafts AS d
             ON d.business_id=a.business_id AND d.id=a.draft_id
          WHERE a.business_id=$1 AND a.id=$2
            AND a.state='AUTHORIZED_PENDING_PROVIDER'
            AND a.provider='WAVE' AND d.status='DRAFT'
          FOR SHARE OF a,d`,
        [tenant, authorizationId]
      );
      if (!authorized.rows.length) {
        throw new ProviderIssuanceAttemptError('AUTHORIZATION_NOT_FOUND', 404);
      }
      const authorization = authorized.rows[0];
      if (authorization.request_hash !== authorization.draft_request_hash) {
        throw new ProviderIssuanceAttemptError('AUTHORIZATION_SNAPSHOT_MISMATCH', 409);
      }
      if (Number(authorization.expected_total_cents) !== authorization.snapshot?.totalCents ||
          typeof authorization.snapshot?.customer?.email !== 'string' ||
          authorization.expected_customer_email !== authorization.snapshot.customer.email.toLowerCase()) {
        throw new ProviderIssuanceAttemptError('AUTHORIZATION_DETAILS_MISMATCH', 409);
      }
      const key = operationKey(tenant, authorization.id, authorization.request_hash);
      const inserted = await client.query(
        `INSERT INTO facturations_provider_issuance_attempts
           (business_id,authorization_id,draft_id,provider,operation_key,state)
         VALUES ($1,$2,$3,'WAVE',$4,'PREPARED')
         ON CONFLICT (business_id,authorization_id) DO NOTHING
         RETURNING *`,
        [tenant, authorization.id, authorization.draft_id, key]
      );
      let row = inserted.rows[0];
      if (row) {
        await client.query(
          `INSERT INTO facturations_provider_issuance_events
             (business_id,attempt_id,from_state,to_state,reason_code)
           VALUES ($1,$2,NULL,'PREPARED','OWNER_AUTHORIZATION_READY')`,
          [tenant, row.id]
        );
      } else {
        const existing = await client.query(
          `SELECT * FROM facturations_provider_issuance_attempts
            WHERE business_id=$1 AND authorization_id=$2`,
          [tenant, authorization.id]
        );
        row = existing.rows[0];
        if (!row || row.draft_id !== authorization.draft_id ||
            row.provider !== 'WAVE' || row.operation_key !== key) {
          throw new ProviderIssuanceAttemptError('PREPARE_CONFLICT', 409);
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

  async function get(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') {
      throw new ProviderIssuanceAttemptError('INVALID_ATTEMPT_LOOKUP');
    }
    const attemptId = uuid(input.attemptId, 'INVALID_ATTEMPT_ID');
    const result = await pool.query(
      'SELECT * FROM facturations_provider_issuance_attempts WHERE business_id=$1 AND id=$2',
      [tenant, attemptId]
    );
    if (!result.rows.length) throw new ProviderIssuanceAttemptError('ATTEMPT_NOT_FOUND', 404);
    return asResult(result.rows[0]);
  }

  async function transition(attemptId, allowedStates, nextState, updateSql, params, eventCode) {
    const id = uuid(attemptId, 'INVALID_ATTEMPT_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const found = await client.query(
        'SELECT * FROM facturations_provider_issuance_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE',
        [tenant, id]
      );
      const row = found.rows[0];
      if (!row) throw new ProviderIssuanceAttemptError('ATTEMPT_NOT_FOUND', 404);
      if (!allowedStates.includes(row.state)) {
        const code = row.state === 'AMBIGUOUS'
          ? 'AMBIGUOUS_REQUIRES_RECONCILIATION'
          : 'INVALID_ATTEMPT_STATE';
        throw new ProviderIssuanceAttemptError(code, 409);
      }
      const updated = await client.query(updateSql, [tenant, id, ...params]);
      if (updated.rows.length !== 1) throw new ProviderIssuanceAttemptError('STORAGE_UNAVAILABLE', 503);
      await client.query(
        `INSERT INTO facturations_provider_issuance_events
           (business_id,attempt_id,from_state,to_state,reason_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant, id, row.state, nextState, eventCode]
      );
      await client.query('COMMIT');
      transaction = false;
      return asResult(updated.rows[0]);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  function start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') {
      throw new ProviderIssuanceAttemptError('INVALID_START_REQUEST');
    }
    return transition(input.attemptId, ['PREPARED'], 'IN_PROGRESS',
      `UPDATE facturations_provider_issuance_attempts
          SET state='IN_PROGRESS',started_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [], 'ADAPTER_STARTED');
  }

  function markAmbiguous(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,reasonCode') {
      throw new ProviderIssuanceAttemptError('INVALID_AMBIGUOUS_RESULT');
    }
    const code = reason(input.reasonCode);
    return transition(input.attemptId, ['IN_PROGRESS'], 'AMBIGUOUS',
      `UPDATE facturations_provider_issuance_attempts
          SET state='AMBIGUOUS',outcome_code=$3
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [code], code);
  }

  function markFailed(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,reasonCode') {
      throw new ProviderIssuanceAttemptError('INVALID_FAILED_RESULT');
    }
    const code = reason(input.reasonCode);
    return transition(input.attemptId, ['IN_PROGRESS', 'AMBIGUOUS'], 'FAILED',
      `UPDATE facturations_provider_issuance_attempts
          SET state='FAILED',outcome_code=$3,finished_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [code], code);
  }

  function markConfirmed(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !==
          'attemptId,providerInvoiceId,providerInvoiceNumber') {
      throw new ProviderIssuanceAttemptError('INVALID_CONFIRMED_RESULT');
    }
    const invoiceId = providerText(input.providerInvoiceId, 'INVALID_PROVIDER_INVOICE_ID');
    const invoiceNumber = providerText(input.providerInvoiceNumber,
      'INVALID_PROVIDER_INVOICE_NUMBER', 160);
    return transition(input.attemptId, ['IN_PROGRESS', 'AMBIGUOUS'], 'CONFIRMED',
      `UPDATE facturations_provider_issuance_attempts
          SET state='CONFIRMED',provider_invoice_id=$3,provider_invoice_number=$4,
              outcome_code=CASE WHEN state='AMBIGUOUS'
                THEN 'RECONCILED_CONFIRMED' ELSE NULL END,
              finished_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [invoiceId, invoiceNumber], 'PROVIDER_CONFIRMED');
  }

  return Object.freeze({ prepare, get, start, markAmbiguous, markFailed, markConfirmed });
}

module.exports = {
  createProviderIssuanceAttemptStore,
  ProviderIssuanceAttemptError,
};
