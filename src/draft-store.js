'use strict';

const crypto = require('node:crypto');
const { previewDraft } = require('./draft-preview');

class StoreError extends Error {
  constructor(code, statusCode = 503) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createDraftStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('PostgreSQL pool is required');
  }
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.length > 200) {
    throw new Error('A dedicated Wave business ID is required');
  }
  const tenant = businessId.trim();

  async function createDraft(payload, idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) {
      throw new StoreError('INVALID_IDEMPOTENCY_KEY', 422);
    }
    const preview = previewDraft(payload); // Recalculate server-side; never trust submitted totals.
    const hash = crypto.createHash('sha256').update(JSON.stringify(preview)).digest('hex');
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const existing = await client.query(
        'SELECT id, request_hash, snapshot, created_at FROM invoice_drafts WHERE business_id=$1 AND idempotency_key=$2',
        [tenant, idempotencyKey]
      );
      if (existing.rows.length) {
        if (existing.rows[0].request_hash !== hash) throw new StoreError('IDEMPOTENCY_CONFLICT', 409);
        await client.query('COMMIT');
        inTransaction = false;
        return toResult(existing.rows[0]);
      }
      const normalizedEmail = preview.customer.email.toLowerCase();
      await client.query(
        'INSERT INTO invoice_customers (business_id,name,email,email_normalized,address) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id,email_normalized) DO NOTHING',
        [tenant, preview.customer.name, preview.customer.email, normalizedEmail, preview.customer.address]
      );
      const customer = await client.query(
        'SELECT id FROM invoice_customers WHERE business_id=$1 AND email_normalized=$2',
        [tenant, normalizedEmail]
      );
      if (!customer.rows.length) throw new StoreError('STORAGE_UNAVAILABLE');
      const stored = { ...preview, status: 'DRAFT', persisted: true };
      const inserted = await client.query(
        'INSERT INTO invoice_drafts (business_id,customer_id,idempotency_key,request_hash,snapshot) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (business_id,idempotency_key) DO NOTHING RETURNING id, request_hash, snapshot, created_at',
        [tenant, customer.rows[0].id, idempotencyKey, hash, JSON.stringify(stored)]
      );
      let row = inserted.rows[0];
      if (row) {
        await client.query(
          "INSERT INTO invoice_audit_events (business_id,draft_id,action) VALUES ($1,$2,'DRAFT_CREATED')",
          [tenant, row.id]
        );
      } else {
        // Concurrent requests with the same key may have raced. Only the first creates an audit event.
        const raced = await client.query(
          'SELECT id, request_hash, snapshot, created_at FROM invoice_drafts WHERE business_id=$1 AND idempotency_key=$2',
          [tenant, idempotencyKey]
        );
        row = raced.rows[0];
        if (!row) throw new StoreError('STORAGE_UNAVAILABLE');
        if (row.request_hash !== hash) throw new StoreError('IDEMPOTENCY_CONFLICT', 409);
      }
      await client.query('COMMIT');
      inTransaction = false;
      return toResult(row);
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* Never mask the original failure. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function getDraft(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
      throw new StoreError('INVALID_DRAFT_ID', 422);
    }
    const result = await pool.query(
      'SELECT id, snapshot, created_at FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [tenant, id]
    );
    if (!result.rows.length) throw new StoreError('DRAFT_NOT_FOUND', 404);
    return toResult(result.rows[0]);
  }

  return Object.freeze({ createDraft, getDraft });
}

function toResult(row) {
  return {
    id: row.id,
    status: 'DRAFT',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    preview: row.snapshot,
    waveSynced: false,
    emailed: false,
  };
}

module.exports = { createDraftStore, StoreError };
