'use strict';

// Read-only backend data for a future authenticated staff dashboard. No issued-invoice
// or revenue metrics exist yet: draft amounts must never be represented as revenue.
class DashboardError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'DashboardError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function pageOptions(pageValue = '1', sizeValue = '20') {
  if (typeof pageValue !== 'string' || !/^[1-9][0-9]{0,3}$/.test(pageValue)) {
    throw new DashboardError('INVALID_PAGE');
  }
  if (typeof sizeValue !== 'string' || !/^[1-9][0-9]{0,2}$/.test(sizeValue)) {
    throw new DashboardError('INVALID_PAGE_SIZE');
  }
  const page = Number(pageValue);
  const pageSize = Number(sizeValue);
  if (page > 1000) throw new DashboardError('INVALID_PAGE');
  if (pageSize > 50) throw new DashboardError('INVALID_PAGE_SIZE');
  return Object.freeze({ page, pageSize, offset: (page - 1) * pageSize });
}

function createDashboardStore({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('A dedicated PostgreSQL pool is required');
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.length > 200) {
    throw new Error('A dedicated business ID is required');
  }
  const tenant = businessId.trim();

  async function listDrafts(options = pageOptions()) {
    const { page, pageSize, offset } = options;
    // Every query includes the business ID. The result excludes email, street address,
    // internal idempotency keys and the full invoice snapshot.
    const result = await pool.query(
      `SELECT d.id, d.created_at, d.snapshot->>'invoiceDate' AS invoice_date,
              d.snapshot->>'dueDate' AS due_date,
              d.snapshot->>'totalCents' AS total_cents,
              c.name AS customer_name
         FROM invoice_drafts AS d
         JOIN invoice_customers AS c
           ON c.business_id=d.business_id AND c.id=d.customer_id
        WHERE d.business_id=$1 AND d.status='DRAFT'
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $2 OFFSET $3`,
      [tenant, pageSize, offset]
    );
    return {
      status: 'DRAFTS_ONLY', page, pageSize,
      drafts: result.rows.map(row => ({
        id: row.id,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        customerName: row.customer_name,
        invoiceDate: row.invoice_date,
        dueDate: row.due_date,
        totalCents: row.total_cents, // integer-cents encoded as string, no precision loss
        currency: 'CAD',
        status: 'DRAFT',
      })),
    };
  }

  async function getSummary() {
    // Use PostgreSQL numeric and string output to avoid JS integer overflow. Draft
    // totals are NOT receivables, sales, payments, or revenue.
    const [drafts, customers] = await Promise.all([
      pool.query(
        `SELECT count(*)::text AS draft_count,
                COALESCE(sum((snapshot->>'totalCents')::numeric), 0)::text AS draft_total_cents
           FROM invoice_drafts WHERE business_id=$1 AND status='DRAFT'`,
        [tenant]
      ),
      pool.query('SELECT count(*)::text AS customer_count FROM invoice_customers WHERE business_id=$1', [tenant]),
    ]);
    return {
      status: 'DRAFTS_ONLY', currency: 'CAD',
      draftCount: drafts.rows[0].draft_count,
      draftTotalCents: drafts.rows[0].draft_total_cents,
      customerCount: customers.rows[0].customer_count,
      issuedInvoicesAvailable: false,
      paymentsAvailable: false,
      revenueAvailable: false,
    };
  }

  return Object.freeze({ listDrafts, getSummary });
}

module.exports = { createDashboardStore, DashboardError, pageOptions };
