'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPS = new Set(['CREATE_DRAFT', 'APPROVE_INVOICE']);

class WaveNetworkAttemptError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveNetworkAttemptError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new WaveNetworkAttemptError('INVALID_EXECUTION_ID');
  }
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) {
    throw new WaveNetworkAttemptError('INVALID_EXECUTION_VERSION');
  }
  return value;
}

function operation(value) {
  if (!OPS.has(value)) throw new WaveNetworkAttemptError('INVALID_NETWORK_OPERATION');
  return value;
}

function rowResult(row) {
  return Object.freeze({
    id: row.id,
    executionId: row.execution_id,
    executionVersion: row.execution_version,
    operation: row.operation,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
  });
}

function createWaveNetworkAttemptStore({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'executionId,executionVersion,operation') {
      throw new WaveNetworkAttemptError('INVALID_NETWORK_ATTEMPT');
    }
    const executionId = uuid(input.executionId);
    const executionVersion = version(input.executionVersion);
    const op = operation(input.operation);

    const execution = await pool.query(
      `SELECT state,version FROM facturations_provider_executions
        WHERE business_id=$1 AND id=$2`,
      [tenant, executionId]
    );
    if (!execution.rows.length) throw new WaveNetworkAttemptError('EXECUTION_NOT_FOUND', 404);
    if (execution.rows[0].state !== 'IN_PROGRESS' ||
        execution.rows[0].version !== executionVersion) {
      throw new WaveNetworkAttemptError('EXECUTION_NOT_IN_PROGRESS', 409);
    }

    const inserted = await pool.query(
      `INSERT INTO facturations_wave_network_attempts
        (business_id,execution_id,execution_version,operation)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id,execution_id,execution_version,operation) DO NOTHING
       RETURNING id,execution_id,execution_version,operation,started_at`,
      [tenant, executionId, executionVersion, op]
    );
    if (inserted.rows.length) return rowResult(inserted.rows[0]);

    const prior = await pool.query(
      `SELECT id,execution_id,execution_version,operation,started_at
         FROM facturations_wave_network_attempts
        WHERE business_id=$1 AND execution_id=$2
          AND execution_version=$3 AND operation=$4`,
      [tenant, executionId, executionVersion, op]
    );
    if (!prior.rows.length) throw new WaveNetworkAttemptError('ATTEMPT_STORAGE_UNAVAILABLE', 503);
    return rowResult(prior.rows[0]);
  }

  async function listCurrent(executionId, executionVersion) {
    uuid(executionId);
    version(executionVersion);
    const result = await pool.query(
      `SELECT id,execution_id,execution_version,operation,started_at
         FROM facturations_wave_network_attempts
        WHERE business_id=$1 AND execution_id=$2 AND execution_version=$3
        ORDER BY started_at,id`,
      [tenant, executionId, executionVersion]
    );
    return Object.freeze(result.rows.map(rowResult));
  }

  return Object.freeze({ start, listCurrent });
}

module.exports = { createWaveNetworkAttemptStore, WaveNetworkAttemptError };
