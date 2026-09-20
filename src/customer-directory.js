'use strict';

const { pageOptions } = require('./dashboard-store');

class CustomerDirectoryError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'CustomerDirectoryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function customerListOptions(searchParams) {
  for (const key of searchParams.keys()) {
    if (!['page', 'pageSize', 'q'].includes(key) || searchParams.getAll(key).length !== 1) {
      throw new CustomerDirectoryError('INVALID_QUERY');
    }
  }
  const pagination = pageOptions(searchParams.get('page') ?? '1', searchParams.get('pageSize') ?? '20');
  const rawSearch = searchParams.get('q');
  if (rawSearch === null) return Object.freeze({ ...pagination, search: null });
  // Validate BEFORE trimming: leading/trailing control characters must never be normalized away.
  if (/[\u0000-\u001f\u007f]/u.test(rawSearch)) throw new CustomerDirectoryError('INVALID_SEARCH');
  const search = rawSearch.trim();
  if (search.length < 2 || search.length > 80) throw new CustomerDirectoryError('INVALID_SEARCH');
  // PostgreSQL ESCAPE '!' treats wildcard characters as literal customer input.
  const pattern = `%${search.replace(/[!%_]/g, ch => '!' + ch)}%`;
  return Object.freeze({ ...pagination, search: pattern });
}

function createCustomerDirectory({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Dedicated PostgreSQL pool required');
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function listCustomers(options) {
    const { page, pageSize, offset, search } = options;
    const result = await pool.query(
      `SELECT c.id,c.name,c.email,c.address,c.created_at
         FROM invoice_customers AS c
        WHERE c.business_id=$1
          AND ($4::text IS NULL OR c.name ILIKE $4 ESCAPE '!' OR c.email_normalized ILIKE $4 ESCAPE '!')
        ORDER BY c.name ASC,c.id ASC
        LIMIT $2 OFFSET $3`,
      [tenant, pageSize + 1, offset, search]
    );
    return {
      status: 'CUSTOMERS_ONLY', page, pageSize, hasMore: result.rows.length > pageSize,
      customers: result.rows.slice(0, pageSize).map(row => ({
        id: row.id, name: row.name, email: row.email, address: row.address,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      })),
    };
  }

  return Object.freeze({ listCustomers });
}

module.exports = { createCustomerDirectory, CustomerDirectoryError, customerListOptions };
