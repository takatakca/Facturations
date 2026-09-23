'use strict';

const crypto = require('node:crypto');
const { buildWaveIssuancePreflight, WaveIssuancePreflightError } = require('./wave-issuance-preflight');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class WaveMappingError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'WaveMappingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !==
        'authorizationId,draftId,productIds,salesTaxes,waveBusinessId,waveCustomerId') {
    throw new WaveMappingError('INVALID_MAPPING');
  }
  if (typeof input.authorizationId !== 'string' || !UUID.test(input.authorizationId)) {
    throw new WaveMappingError('INVALID_AUTHORIZATION_ID');
  }
  if (typeof input.draftId !== 'string' || !UUID.test(input.draftId)) {
    throw new WaveMappingError('INVALID_DRAFT_ID');
  }
  return input;
}

function digestPlan(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function createWaveMappingStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function buildValidatedPlan(client, fields) {
    const result = await client.query(
      `SELECT a.id,a.draft_id,d.snapshot
         FROM facturations_issuance_authorizations AS a
         JOIN invoice_drafts AS d
           ON d.business_id=a.business_id AND d.id=a.draft_id
        WHERE a.business_id=$1 AND a.id=$2 AND d.status='DRAFT'
        FOR SHARE OF a,d`,
      [tenant, fields.authorizationId]
    );
    if (!result.rows.length) throw new WaveMappingError('AUTHORIZATION_NOT_FOUND', 404);
    const row = result.rows[0];
    if (row.draft_id !== fields.draftId) throw new WaveMappingError('AUTHORIZATION_MISMATCH', 409);
    try {
      return buildWaveIssuancePreflight({
        snapshot: row.snapshot,
        businessId: fields.waveBusinessId,
        customerId: fields.waveCustomerId,
        productIds: fields.productIds,
        salesTaxes: fields.salesTaxes,
      });
    } catch (error) {
      if (error instanceof WaveIssuancePreflightError) {
        throw new WaveMappingError(error.code, error.statusCode);
      }
      throw error;
    }
  }

  async function getByAuthorization(authorizationId) {
    if (typeof authorizationId !== 'string' || !UUID.test(authorizationId)) {
      throw new WaveMappingError('INVALID_AUTHORIZATION_ID');
    }
    const main = await pool.query(
      `SELECT id,authorization_id,draft_id,wave_business_id,wave_customer_id,plan_hash,created_at
         FROM facturations_wave_issuance_mappings
        WHERE business_id=$1 AND authorization_id=$2`,
      [tenant, authorizationId]
    );
    if (!main.rows.length) throw new WaveMappingError('MAPPING_NOT_FOUND', 404);
    const mapping = main.rows[0];
    const [lines, taxes, draft] = await Promise.all([
      pool.query(
        `SELECT line_index,wave_product_id
           FROM facturations_wave_line_mappings
          WHERE business_id=$1 AND mapping_id=$2 ORDER BY line_index`,
        [tenant, mapping.id]
      ),
      pool.query(
        `SELECT tax_code,wave_sales_tax_id,rate_milli_percent
           FROM facturations_wave_tax_mappings
          WHERE business_id=$1 AND mapping_id=$2 ORDER BY tax_code`,
        [tenant, mapping.id]
      ),
      pool.query(
        `SELECT d.snapshot
           FROM facturations_issuance_authorizations a
           JOIN invoice_drafts d ON d.business_id=a.business_id AND d.id=a.draft_id
          WHERE a.business_id=$1 AND a.id=$2 AND d.id=$3 AND d.status='DRAFT'`,
        [tenant, authorizationId, mapping.draft_id]
      ),
    ]);
    if (!draft.rows.length) throw new WaveMappingError('MAPPING_SOURCE_UNAVAILABLE', 409);
    const productIds = lines.rows.map((row,index) => {
      if (row.line_index !== index) throw new WaveMappingError('MAPPING_LINE_GAP', 409);
      return row.wave_product_id;
    });
    const salesTaxes = Object.fromEntries(taxes.rows.map(row => [
      row.tax_code,
      { id: row.wave_sales_tax_id, rateMilliPercent: row.rate_milli_percent },
    ]));
    let plan;
    try {
      plan = buildWaveIssuancePreflight({
        snapshot: draft.rows[0].snapshot,
        businessId: mapping.wave_business_id,
        customerId: mapping.wave_customer_id,
        productIds,
        salesTaxes,
      });
    } catch (error) {
      if (error instanceof WaveIssuancePreflightError) {
        throw new WaveMappingError(error.code, error.statusCode);
      }
      throw error;
    }
    if (digestPlan(plan) !== mapping.plan_hash) {
      throw new WaveMappingError('MAPPING_HASH_MISMATCH', 409);
    }
    return Object.freeze({
      id: mapping.id,
      authorizationId: mapping.authorization_id,
      draftId: mapping.draft_id,
      createdAt: mapping.created_at instanceof Date ? mapping.created_at.toISOString() : mapping.created_at,
      plan,
    });
  }

  async function save(input) {
    const fields = validateInput(input);
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN');
      transaction = true;
      const plan = await buildValidatedPlan(client, fields);
      const planHash = digestPlan(plan);
      const inserted = await client.query(
        `INSERT INTO facturations_wave_issuance_mappings
          (business_id,authorization_id,draft_id,wave_business_id,wave_customer_id,plan_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (business_id,authorization_id) DO NOTHING
         RETURNING id,authorization_id,draft_id,wave_business_id,wave_customer_id,plan_hash,created_at`,
        [tenant, fields.authorizationId, fields.draftId, plan.businessId, plan.customerId, planHash]
      );
      let mapping = inserted.rows[0];
      if (mapping) {
        for (let index = 0; index < plan.items.length; index++) {
          await client.query(
            `INSERT INTO facturations_wave_line_mappings
              (business_id,mapping_id,line_index,wave_product_id)
             VALUES ($1,$2,$3,$4)`,
            [tenant, mapping.id, index, plan.items[index].productId]
          );
        }
        for (const [taxCode, tax] of Object.entries(fields.salesTaxes)) {
          await client.query(
            `INSERT INTO facturations_wave_tax_mappings
              (business_id,mapping_id,tax_code,wave_sales_tax_id,rate_milli_percent)
             VALUES ($1,$2,$3,$4,$5)`,
            [tenant, mapping.id, taxCode, tax.id, tax.rateMilliPercent]
          );
        }
      } else {
        const prior = await client.query(
          `SELECT id,authorization_id,draft_id,wave_business_id,wave_customer_id,plan_hash,created_at
             FROM facturations_wave_issuance_mappings
            WHERE business_id=$1 AND authorization_id=$2`,
          [tenant, fields.authorizationId]
        );
        mapping = prior.rows[0];
        if (!mapping || mapping.draft_id !== fields.draftId ||
            mapping.wave_business_id !== plan.businessId ||
            mapping.wave_customer_id !== plan.customerId ||
            mapping.plan_hash !== planHash) {
          throw new WaveMappingError('MAPPING_CONFLICT', 409);
        }
      }
      await client.query('COMMIT');
      transaction = false;
      return Object.freeze({
        id: mapping.id,
        authorizationId: mapping.authorization_id,
        draftId: mapping.draft_id,
        createdAt: mapping.created_at instanceof Date ? mapping.created_at.toISOString() : mapping.created_at,
        plan,
      });
    } catch (error) {
      if (transaction) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ save, getByAuthorization });
}

module.exports = { createWaveMappingStore, WaveMappingError };
