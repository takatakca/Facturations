'use strict';

// Internal approval is NOT issuance, a payment, revenue, or a Wave operation.
const { pageOptions } = require('./dashboard-store');

class ApprovalLedgerError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = 'ApprovalLedgerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function approvalPageOptions(params) {
  for (const key of params.keys()) {
    if (!['page', 'pageSize'].includes(key) || params.getAll(key).length !== 1) {
      throw new ApprovalLedgerError('INVALID_QUERY');
    }
  }
  return pageOptions(params.get('page') ?? '1', params.get('pageSize') ?? '20');
}

function createApprovalLedger({ pool, businessId }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Dedicated PostgreSQL pool required');
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.trim().length > 200) {
    throw new Error('Dedicated business ID required');
  }
  const tenant = businessId.trim();

  async function listApprovals(options = pageOptions()) {
    const { page, pageSize, offset } = options;
    const rows = await pool.query(
      `SELECT a.id, a.draft_id, a.approved_by, a.approved_at,
              d.snapshot->>'totalCents' AS total_cents
         FROM facturations_draft_approvals AS a
         JOIN invoice_drafts AS d
           ON d.business_id=a.business_id AND d.id=a.draft_id
        WHERE a.business_id=$1
        ORDER BY a.approved_at DESC, a.id DESC
        LIMIT $2 OFFSET $3`,
      [tenant, pageSize + 1, offset]
    );
    return {
      status: 'INTERNAL_APPROVALS_ONLY', currency: 'CAD', page, pageSize,
      hasMore: rows.rows.length > pageSize,
      approvals: rows.rows.slice(0, pageSize).map(row => ({
        id: row.id,
        draftId: row.draft_id,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : row.approved_at,
        totalCents: row.total_cents,
        status: 'APPROVED_INTERNAL_ONLY',
        issued: false, waveSynced: false, emailed: false, paid: false,
      })),
    };
  }

  return Object.freeze({ listApprovals });
}

module.exports = { createApprovalLedger, ApprovalLedgerError, approvalPageOptions };
