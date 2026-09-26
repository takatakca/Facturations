'use strict';

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const STATES = new Set(['PREPARED','IN_PROGRESS','AMBIGUOUS','CONFIRMED','FAILED']);

class DeliveryAttemptError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'DeliveryAttemptError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DeliveryAttemptError(code);
  return value.toLowerCase();
}
function reason(value) {
  if (typeof value !== 'string' || !CODE.test(value)) throw new DeliveryAttemptError('INVALID_OUTCOME_CODE');
  return value;
}
function providerText(value, code, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeliveryAttemptError(code);
  }
  return value.trim();
}
function operationKey(tenant, authorizationId, documentHash, recipientHash) {
  return 'mail_' + crypto.createHash('sha256')
    .update('facturations-delivery-operation-v1\0')
    .update(tenant).update('\0')
    .update(authorizationId).update('\0')
    .update(documentHash).update('\0')
    .update(recipientHash)
    .digest('base64url');
}
function asResult(row) {
  if (!row || !STATES.has(row.state)) throw new DeliveryAttemptError('STORAGE_UNAVAILABLE', 503);
  return Object.freeze({
    id: row.id,
    authorizationId: row.authorization_id,
    issuedInvoiceId: row.issued_invoice_id,
    qualifiedDocumentId: row.qualified_document_id,
    provider: row.provider,
    operationKey: row.operation_key,
    state: row.state,
    providerMessageId: row.provider_message_id || null,
    outcomeCode: row.outcome_code || null,
    preparedAt: row.prepared_at instanceof Date ? row.prepared_at.toISOString() : row.prepared_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at || null),
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : (row.finished_at || null),
    emailed: row.state === 'CONFIRMED',
  });
}

function createDeliveryAttemptStore({ pool, businessId }) {
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
      throw new DeliveryAttemptError('INVALID_PREPARE_REQUEST');
    }
    const authorizationId = uuid(input.authorizationId, 'INVALID_AUTHORIZATION_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const found = await client.query(
        `SELECT a.id,a.issued_invoice_id,a.qualified_document_id,a.qualified_document_sha256,
                a.expected_recipient_email,a.recipient_snapshot_hash,a.state,
                q.content_sha256,q.delivery_state AS document_delivery_state,
                i.status AS invoice_status,i.delivery_state AS invoice_delivery_state,
                i.issued_snapshot
           FROM facturations_delivery_authorizations AS a
           JOIN facturations_qualified_invoice_documents AS q
             ON q.business_id=a.business_id AND q.id=a.qualified_document_id
           JOIN facturations_issued_invoices AS i
             ON i.business_id=a.business_id AND i.id=a.issued_invoice_id
          WHERE a.business_id=$1 AND a.id=$2
          FOR SHARE OF a,q,i`,
        [tenant, authorizationId]
      );
      if (!found.rows.length) throw new DeliveryAttemptError('AUTHORIZATION_NOT_FOUND', 404);
      const auth = found.rows[0];
      if (auth.state !== 'AUTHORIZED_PENDING_DELIVERY' ||
          auth.invoice_status !== 'ISSUED_CONFIRMED' ||
          auth.document_delivery_state !== 'NOT_AUTHORIZED' ||
          auth.invoice_delivery_state !== 'NOT_AUTHORIZED') {
        throw new DeliveryAttemptError('AUTHORIZATION_NOT_READY', 409);
      }
      const recipient = auth.issued_snapshot?.customer?.email;
      if (auth.qualified_document_sha256 !== auth.content_sha256 ||
          typeof recipient !== 'string' ||
          recipient.toLowerCase() !== auth.expected_recipient_email) {
        throw new DeliveryAttemptError('AUTHORIZATION_PROVENANCE_MISMATCH', 409);
      }

      const key = operationKey(
        tenant, auth.id, auth.qualified_document_sha256, auth.recipient_snapshot_hash
      );
      const inserted = await client.query(
        `INSERT INTO facturations_delivery_attempts
           (business_id,authorization_id,issued_invoice_id,qualified_document_id,
            provider,operation_key,state)
         VALUES ($1,$2,$3,$4,'SIMULATED_EMAIL',$5,'PREPARED')
         ON CONFLICT (business_id,authorization_id) DO NOTHING
         RETURNING *`,
        [tenant,auth.id,auth.issued_invoice_id,auth.qualified_document_id,key]
      );
      let row = inserted.rows[0];
      if (row) {
        await client.query(
          `INSERT INTO facturations_delivery_events
             (business_id,attempt_id,from_state,to_state,reason_code)
           VALUES ($1,$2,NULL,'PREPARED','OWNER_DELIVERY_AUTHORIZATION_READY')`,
          [tenant,row.id]
        );
      } else {
        const existing = await client.query(
          'SELECT * FROM facturations_delivery_attempts WHERE business_id=$1 AND authorization_id=$2',
          [tenant,auth.id]
        );
        row = existing.rows[0];
        if (!row || row.issued_invoice_id !== auth.issued_invoice_id ||
            row.qualified_document_id !== auth.qualified_document_id ||
            row.provider !== 'SIMULATED_EMAIL' || row.operation_key !== key) {
          throw new DeliveryAttemptError('PREPARE_CONFLICT',409);
        }
      }
      await client.query('COMMIT');
      transaction = false;
      return asResult(row);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function get(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') {
      throw new DeliveryAttemptError('INVALID_ATTEMPT_LOOKUP');
    }
    const attemptId = uuid(input.attemptId, 'INVALID_ATTEMPT_ID');
    const found = await pool.query(
      'SELECT * FROM facturations_delivery_attempts WHERE business_id=$1 AND id=$2',
      [tenant,attemptId]
    );
    if (!found.rows.length) throw new DeliveryAttemptError('ATTEMPT_NOT_FOUND',404);
    return asResult(found.rows[0]);
  }

  async function transition(attemptId, allowed, nextState, sql, params, eventCode) {
    const id = uuid(attemptId,'INVALID_ATTEMPT_ID');
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const found = await client.query(
        'SELECT * FROM facturations_delivery_attempts WHERE business_id=$1 AND id=$2 FOR UPDATE',
        [tenant,id]
      );
      const row = found.rows[0];
      if (!row) throw new DeliveryAttemptError('ATTEMPT_NOT_FOUND',404);
      if (!allowed.includes(row.state)) {
        throw new DeliveryAttemptError(
          row.state === 'AMBIGUOUS' ? 'AMBIGUOUS_REQUIRES_RECONCILIATION' : 'INVALID_ATTEMPT_STATE',
          409
        );
      }
      const updated = await client.query(sql,[tenant,id,...params]);
      if (updated.rows.length !== 1) throw new DeliveryAttemptError('STORAGE_UNAVAILABLE',503);
      await client.query(
        `INSERT INTO facturations_delivery_events
           (business_id,attempt_id,from_state,to_state,reason_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant,id,row.state,nextState,eventCode]
      );
      await client.query('COMMIT');
      transaction = false;
      return asResult(updated.rows[0]);
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw error;
    } finally {
      client.release();
    }
  }

  function start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'attemptId') throw new DeliveryAttemptError('INVALID_START_REQUEST');
    return transition(input.attemptId,['PREPARED'],'IN_PROGRESS',
      `UPDATE facturations_delivery_attempts
          SET state='IN_PROGRESS',started_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [],'ADAPTER_STARTED');
  }
  function markAmbiguous(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,reasonCode') {
      throw new DeliveryAttemptError('INVALID_AMBIGUOUS_RESULT');
    }
    const code=reason(input.reasonCode);
    return transition(input.attemptId,['IN_PROGRESS'],'AMBIGUOUS',
      `UPDATE facturations_delivery_attempts
          SET state='AMBIGUOUS',outcome_code=$3
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [code],code);
  }
  function markFailed(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,reasonCode') {
      throw new DeliveryAttemptError('INVALID_FAILED_RESULT');
    }
    const code=reason(input.reasonCode);
    return transition(input.attemptId,['IN_PROGRESS','AMBIGUOUS'],'FAILED',
      `UPDATE facturations_delivery_attempts
          SET state='FAILED',outcome_code=$3,finished_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [code],code);
  }
  function markConfirmed(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'attemptId,providerMessageId') {
      throw new DeliveryAttemptError('INVALID_CONFIRMED_RESULT');
    }
    const providerMessageId=providerText(input.providerMessageId,'INVALID_PROVIDER_MESSAGE_ID');
    return transition(input.attemptId,['IN_PROGRESS','AMBIGUOUS'],'CONFIRMED',
      `UPDATE facturations_delivery_attempts
          SET state='CONFIRMED',provider_message_id=$3,
              outcome_code=CASE WHEN state='AMBIGUOUS' THEN 'RECONCILED_CONFIRMED' ELSE NULL END,
              finished_at=now()
        WHERE business_id=$1 AND id=$2 RETURNING *`,
      [providerMessageId],'PROVIDER_CONFIRMED');
  }

  return Object.freeze({prepare,get,start,markAmbiguous,markFailed,markConfirmed});
}

module.exports={createDeliveryAttemptStore,DeliveryAttemptError};
