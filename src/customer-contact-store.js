'use strict';

const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
class CustomerContactError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'CustomerContactError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
function validateContact(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new CustomerContactError('INVALID_CONTACT');
  const { name, email, address } = fields;
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new CustomerContactError('INVALID_NAME');
  }
  if (typeof email !== 'string' || email.length > 254 || /[\u0000-\u001f\u007f]/u.test(email) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()) || email.trim().length < 3) {
    throw new CustomerContactError('INVALID_EMAIL');
  }
  if (typeof address !== 'string' || address.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(address)) {
    throw new CustomerContactError('INVALID_ADDRESS');
  }
  return Object.freeze({ name: name.trim(), email: email.trim(),
    emailNormalized: email.trim().toLowerCase(), address: address.trim() });
}
function createCustomerContactStore({ pool, businessId }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function' ||
      typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new TypeError('Dedicated PostgreSQL and business ID required');
  }
  const tenant = businessId.trim();
  async function getContact(id) {
    if (!UUID.test(id || '')) throw new CustomerContactError('INVALID_ID');
    const found = await pool.query(
      'SELECT id,name,email,address,contact_revision FROM invoice_customers WHERE business_id=$1 AND id=$2', [tenant, id]
    );
    if (!found.rows.length) throw new CustomerContactError('NOT_FOUND', 404);
    const row = found.rows[0];
    return Object.freeze({ id: row.id, name: row.name, email: row.email,
      address: row.address || '', revision: row.contact_revision });
  }
  async function saveContact({ sessionToken, ownerId, id = null, expectedRevision = null, name, email, address }) {
    if (!TOKEN.test(sessionToken || '') || !UUID.test(ownerId || '')) throw new CustomerContactError('OWNER_REQUIRED', 403);
    if (id !== null && (!UUID.test(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new CustomerContactError('INVALID_REVISION');
    }
    if (id === null && expectedRevision !== null) throw new CustomerContactError('INVALID_REVISION');
    const contact = validateContact({ name, email, address });
    const digest = crypto.createHash('sha256').update(sessionToken, 'utf8').digest();
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN'); transaction = true;
      const owner = await client.query(
        `SELECT u.id FROM facturations_staff_sessions AS s
           JOIN facturations_staff_users AS u ON u.business_id=s.business_id AND u.id=s.user_id
          WHERE s.business_id=$1 AND s.user_id=$2 AND s.token_hash=$3
            AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.enabled AND u.email_verified_at IS NOT NULL AND u.role='OWNER'
          FOR SHARE OF s,u`, [tenant, ownerId, digest]
      );
      if (!owner.rows.length) throw new CustomerContactError('OWNER_REQUIRED', 403);
      let row;
      if (id === null) {
        const inserted = await client.query(
          `INSERT INTO invoice_customers (business_id,name,email,email_normalized,address)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id,email_normalized) DO NOTHING
           RETURNING id,contact_revision`,
          [tenant, contact.name, contact.email, contact.emailNormalized, contact.address]
        );
        row = inserted.rows[0];
        if (!row) throw new CustomerContactError('EMAIL_EXISTS', 409);
      } else {
        const found = await client.query(
          'SELECT contact_revision FROM invoice_customers WHERE business_id=$1 AND id=$2 FOR UPDATE', [tenant, id]
        );
        if (!found.rows.length) throw new CustomerContactError('NOT_FOUND', 404);
        if (found.rows[0].contact_revision !== expectedRevision || expectedRevision >= 2147483647) {
          throw new CustomerContactError('REVISION_CONFLICT', 409);
        }
        const changed = await client.query(
          `UPDATE invoice_customers
              SET name=$3,email=$4,email_normalized=$5,address=$6,contact_revision=contact_revision+1
            WHERE business_id=$1 AND id=$2 RETURNING id,contact_revision`,
          [tenant, id, contact.name, contact.email, contact.emailNormalized, contact.address]
        );
        row = changed.rows[0];
      }
      await client.query(
        `INSERT INTO facturations_customer_contact_events
         (business_id,customer_id,changed_by,action,contact_revision) VALUES ($1,$2,$3,$4,$5)`,
        [tenant, row.id, ownerId, id === null ? 'CREATED' : 'UPDATED', row.contact_revision]
      );
      await client.query('COMMIT'); transaction = false;
      return Object.freeze({ id: row.id, revision: row.contact_revision, action: id === null ? 'CREATED' : 'UPDATED' });
    } catch (error) {
      if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ } }
      if (error?.code === '23505') throw new CustomerContactError('EMAIL_EXISTS', 409);
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ getContact, saveContact });
}
module.exports = { createCustomerContactStore, CustomerContactError, validateContact };
