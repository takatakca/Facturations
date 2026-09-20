'use strict';

const TOKEN_HEADER = /^Bearer ([A-Za-z0-9_-]{43})$/;

// This guard is ONLY for read-only staff APIs, not a browser login or customer portal.
// Sessions must be issued by a trusted, independently verified enrollment flow.
async function resolveReadOnlyStaff({ authorization, store, businessId }) {
  if (typeof authorization !== 'string' || !TOKEN_HEADER.test(authorization)) return null;
  if (!store || typeof store.getSession !== 'function' ||
      typeof businessId !== 'string' || businessId.trim().length === 0) return null;
  const token = TOKEN_HEADER.exec(authorization)[1];
  const staff = await store.getSession(token);
  if (!staff || staff.businessId !== businessId ||
      !['OWNER', 'STAFF'].includes(staff.role) || typeof staff.id !== 'string') return null;
  return Object.freeze({ id: staff.id, businessId: staff.businessId, role: staff.role });
}

module.exports = { resolveReadOnlyStaff };
