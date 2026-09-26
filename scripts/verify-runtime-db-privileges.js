'use strict';

const { Pool } = require('pg');

const EXPECTED_TABLES = Object.freeze([
  'facturations_client_access_links',
  'facturations_client_portal_publication_revocations',
  'facturations_client_portal_publications',
  'facturations_client_portal_users',
  'facturations_client_sessions',
  'facturations_customer_contact_events',
  'facturations_delivery_attempts',
  'facturations_delivery_authorizations',
  'facturations_delivery_events',
  'facturations_delivery_receipts',
  'facturations_draft_approvals',
  'facturations_draft_workspace_revisions',
  'facturations_draft_workspaces',
  'facturations_email_provider_evidence',
  'facturations_invoice_issuer_bindings',
  'facturations_issuance_authorizations',
  'facturations_issued_invoice_documents',
  'facturations_issued_invoices',
  'facturations_issuer_profiles',
  'facturations_login_attempt_limits',
  'facturations_payment_evidence',
  'facturations_provider_issuance_attempts',
  'facturations_provider_issuance_events',
  'facturations_qualified_invoice_documents',
  'facturations_staff_invitations',
  'facturations_staff_sessions',
  'facturations_staff_totp',
  'facturations_staff_users',
  'facturations_workspace_submissions',
  'invoice_audit_events',
  'invoice_customers',
  'invoice_drafts',
].sort());

const EXPECTED_VIEWS = Object.freeze([
  'facturations_email_provider_evidence_summary',
  'facturations_payment_evidence_summary',
].sort());

const UPDATE_TABLES = new Set([
  'invoice_customers',
  'facturations_staff_users',
  'facturations_staff_sessions',
  'facturations_staff_invitations',
  'facturations_login_attempt_limits',
  'facturations_staff_totp',
  'facturations_draft_workspaces',
  'facturations_provider_issuance_attempts',
  'facturations_delivery_attempts',
  'facturations_client_portal_users',
  'facturations_client_access_links',
  'facturations_client_sessions',
]);

const DELETE_TABLES = new Set(['facturations_login_attempt_limits']);

function sameList(actual, expected) {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function invariant(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

async function privilege(pool, objectName, type, privilegeName) {
  const fn = type === 'sequence' ? 'has_sequence_privilege' : 'has_table_privilege';
  const sql = 'SELECT ' + fn + '(current_user,$1,$2) AS allowed';
  const result = await pool.query(sql, ['public.' + objectName, privilegeName]);
  return result.rows[0].allowed === true;
}

async function verifyRuntimePrivileges({ pool }) {
  const roleResult = await pool.query(
    "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, " +
    "rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user"
  );
  const role = roleResult.rows[0];
  invariant(role, 'RUNTIME_ROLE_NOT_FOUND');
  invariant(!role.rolsuper, 'RUNTIME_ROLE_SUPERUSER_FORBIDDEN');
  invariant(!role.rolcreatedb, 'RUNTIME_ROLE_CREATEDB_FORBIDDEN');
  invariant(!role.rolcreaterole, 'RUNTIME_ROLE_CREATEROLE_FORBIDDEN');
  invariant(!role.rolreplication, 'RUNTIME_ROLE_REPLICATION_FORBIDDEN');
  invariant(!role.rolbypassrls, 'RUNTIME_ROLE_BYPASSRLS_FORBIDDEN');

  const membership = await pool.query(
    "SELECT count(*)::integer AS n FROM pg_auth_members " +
    "WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)"
  );
  invariant(membership.rows[0].n === 0, 'RUNTIME_ROLE_MEMBERSHIP_FORBIDDEN');

  const db = await pool.query(
    "SELECT " +
    "has_database_privilege(current_user,current_database(),'CONNECT') AS connect, " +
    "has_database_privilege(current_user,current_database(),'CREATE') AS create, " +
    "has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary"
  );
  invariant(db.rows[0].connect === true, 'RUNTIME_DATABASE_CONNECT_REQUIRED');
  invariant(db.rows[0].create === false, 'RUNTIME_DATABASE_CREATE_FORBIDDEN');
  invariant(db.rows[0].temporary === false, 'RUNTIME_DATABASE_TEMP_FORBIDDEN');

  const schema = await pool.query(
    "SELECT " +
    "has_schema_privilege(current_user,'public','USAGE') AS usage, " +
    "has_schema_privilege(current_user,'public','CREATE') AS create"
  );
  invariant(schema.rows[0].usage === true, 'RUNTIME_SCHEMA_USAGE_REQUIRED');
  invariant(schema.rows[0].create === false, 'RUNTIME_SCHEMA_CREATE_FORBIDDEN');

  const tablesResult = await pool.query(
    "SELECT tablename FROM pg_tables " +
    "WHERE schemaname='public' " +
    "AND (tablename LIKE 'facturations_%' OR tablename LIKE 'invoice_%') " +
    "ORDER BY tablename"
  );
  const tables = tablesResult.rows.map(row => row.tablename);
  invariant(sameList(tables, EXPECTED_TABLES), 'RUNTIME_TABLE_INVENTORY_CHANGED');

  const viewsResult = await pool.query(
    "SELECT viewname FROM pg_views " +
    "WHERE schemaname='public' AND viewname LIKE 'facturations_%' " +
    "ORDER BY viewname"
  );
  const views = viewsResult.rows.map(row => row.viewname);
  invariant(sameList(views, EXPECTED_VIEWS), 'RUNTIME_VIEW_INVENTORY_CHANGED');

  for (const table of tables) {
    invariant(await privilege(pool, table, 'table', 'SELECT'),
      'RUNTIME_SELECT_REQUIRED_' + table);
    invariant(await privilege(pool, table, 'table', 'INSERT'),
      'RUNTIME_INSERT_REQUIRED_' + table);

    const canUpdate = await privilege(pool, table, 'table', 'UPDATE');
    invariant(canUpdate === UPDATE_TABLES.has(table),
      'RUNTIME_UPDATE_MATRIX_MISMATCH_' + table);

    const canDelete = await privilege(pool, table, 'table', 'DELETE');
    invariant(canDelete === DELETE_TABLES.has(table),
      'RUNTIME_DELETE_MATRIX_MISMATCH_' + table);

    for (const denied of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      invariant(!(await privilege(pool, table, 'table', denied)),
        'RUNTIME_' + denied + '_FORBIDDEN_' + table);
    }
  }

  for (const view of views) {
    invariant(await privilege(pool, view, 'table', 'SELECT'),
      'RUNTIME_VIEW_SELECT_REQUIRED_' + view);
    for (const denied of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      invariant(!(await privilege(pool, view, 'table', denied)),
        'RUNTIME_VIEW_' + denied + '_FORBIDDEN_' + view);
    }
  }

  const owners = await pool.query(
    "SELECT count(*)::integer AS n FROM pg_class c " +
    "JOIN pg_namespace n ON n.oid=c.relnamespace " +
    "WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') " +
    "AND pg_get_userbyid(c.relowner)=current_user"
  );
  invariant(owners.rows[0].n === 0, 'RUNTIME_OBJECT_OWNERSHIP_FORBIDDEN');

  const functionOwners = await pool.query(
    "SELECT count(*)::integer AS n FROM pg_proc p " +
    "JOIN pg_namespace n ON n.oid=p.pronamespace " +
    "WHERE n.nspname='public' AND p.proname LIKE 'facturations_%' " +
    "AND pg_get_userbyid(p.proowner)=current_user"
  );
  invariant(functionOwners.rows[0].n === 0, 'RUNTIME_FUNCTION_OWNERSHIP_FORBIDDEN');

  const sequences = await pool.query(
    "SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename"
  );
  for (const row of sequences.rows) {
    invariant(await privilege(pool, row.sequencename, 'sequence', 'USAGE'),
      'RUNTIME_SEQUENCE_USAGE_REQUIRED_' + row.sequencename);
    invariant(await privilege(pool, row.sequencename, 'sequence', 'SELECT'),
      'RUNTIME_SEQUENCE_SELECT_REQUIRED_' + row.sequencename);
    invariant(!(await privilege(pool, row.sequencename, 'sequence', 'UPDATE')),
      'RUNTIME_SEQUENCE_UPDATE_FORBIDDEN_' + row.sequencename);
  }

  return Object.freeze({
    passed: true,
    role: role.name,
    tables: tables.length,
    views: views.length,
    sequences: sequences.rows.length,
  });
}

async function main() {
  const raw = process.env.FACTURATIONS_RUNTIME_DATABASE_URL;
  if (!raw) throw new Error('FACTURATIONS_RUNTIME_DATABASE_URL_REQUIRED');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/facturations_test') {
    throw new Error('REFUSING_NON_DISPOSABLE_DATABASE');
  }
  const pool = new Pool({ connectionString: raw, connectionTimeoutMillis: 5000 });
  try {
    const result = await verifyRuntimePrivileges({ pool });
    console.log(
      'PASS: least-privilege runtime role verified (' +
      result.tables + ' tables, ' + result.views + ' views, ' +
      result.sequences + ' sequences).'
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(
      'FAIL: runtime DB privilege verification — ' +
      (error && error.code ? error.code : error.message)
    );
    process.exitCode = 1;
  });
}

module.exports = {
  verifyRuntimePrivileges,
  EXPECTED_TABLES,
  EXPECTED_VIEWS,
  UPDATE_TABLES,
  DELETE_TABLES,
};
