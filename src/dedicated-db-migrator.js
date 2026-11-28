'use strict';

// Operator-only preparation of the DEDICATED Facturations PostgreSQL database.
// Never wired to HTTP and never run by the application process.
//
// 1. Verifies the append-only migration integrity lock (001..N).
// 2. Refuses any database that already contains a foreign schema (for
//    example a TAKATAK database) or an untracked Facturations schema.
// 3. Applies only the pending locked migrations, in order, recording each in
//    facturations_schema_migrations. Each migration file is its own
//    transaction; a crash between files leaves a STARTED marker that blocks
//    further runs until an operator reconciles it.
// 4. Optionally creates/updates the least-privilege runtime LOGIN role.
//    ops/runtime-db-grants.sql is applied separately through psql.

const fs = require('node:fs');
const path = require('node:path');
const { loadLock, verifyMigrationIntegrity } = require('../scripts/verify-migration-integrity');

const CONFIRMATION = 'APPLY_FACTURATIONS_MIGRATIONS';
const LEDGER = 'facturations_schema_migrations';
const ADVISORY_LOCK_KEY = 7_204_311_045;
const OWN_TABLE = /^(facturations_|invoice_)[a-z0-9_]+$/u;
const ROLE_NAME = /^[a-z_][a-z0-9_]{2,62}$/u;
const FORBIDDEN_ROLE_NAMES = new Set(['postgres', 'public', 'pg_database_owner']);

class DedicatedDbMigrationError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'DedicatedDbMigrationError';
    this.code = code;
    this.detail = detail;
  }
}

function lockedMigrations({ dbDir, lockPath } = {}) {
  verifyMigrationIntegrity({ dbDir, lockPath });
  return loadLock(lockPath).migrations.map((item, index) => ({
    sequence: index + 1,
    file: item.file,
    sha1: item.gitBlobSha1,
  }));
}

async function publicTables(client) {
  const result = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
      ORDER BY c.relname`
  );
  return result.rows.map(row => row.name);
}

/**
 * Pure decision on what is already in the target database.
 * Returns 'FRESH' | 'TRACKED'; throws on anything unsafe.
 */
function classifyExistingSchema(tables) {
  const foreign = tables.filter(name => name !== LEDGER && !OWN_TABLE.test(name));
  if (foreign.length > 0) {
    throw new DedicatedDbMigrationError('FOREIGN_SCHEMA_DETECTED', foreign.slice(0, 10));
  }
  const own = tables.filter(name => name !== LEDGER);
  if (tables.includes(LEDGER)) return 'TRACKED';
  if (own.length > 0) throw new DedicatedDbMigrationError('UNTRACKED_FACTURATIONS_SCHEMA');
  return 'FRESH';
}

/**
 * Pure comparison of the ledger with the locked migration list.
 * Returns the pending migrations; throws on drift or interrupted runs.
 */
function planPendingMigrations(locked, ledgerRows) {
  const rows = [...ledgerRows].sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = locked[index];
    if (!expected || row.sequence !== expected.sequence || row.filename !== expected.file) {
      throw new DedicatedDbMigrationError('MIGRATION_LEDGER_DRIFT', { sequence: row.sequence });
    }
    if (row.git_blob_sha1 !== expected.sha1) {
      throw new DedicatedDbMigrationError('MIGRATION_CONTENT_DRIFT', { sequence: row.sequence });
    }
    if (row.state !== 'APPLIED') {
      throw new DedicatedDbMigrationError('INTERRUPTED_MIGRATION', { sequence: row.sequence, file: row.filename });
    }
  }
  return locked.slice(rows.length);
}

function validateRuntimeRole(role, password) {
  if (typeof role !== 'string' || !ROLE_NAME.test(role) || FORBIDDEN_ROLE_NAMES.has(role)) {
    throw new DedicatedDbMigrationError('RUNTIME_ROLE_INVALID');
  }
  if (typeof password !== 'string' || password.length < 24 || password.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(password)) {
    throw new DedicatedDbMigrationError('RUNTIME_PASSWORD_INVALID');
  }
}

async function ensureRuntimeRole(client, role, password) {
  validateRuntimeRole(role, password);
  const current = await client.query('SELECT current_user AS name');
  if (current.rows[0].name === role) throw new DedicatedDbMigrationError('RUNTIME_ROLE_EQUALS_MIGRATOR');
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  const verb = exists.rows.length === 1 ? 'ALTER' : 'CREATE';
  const statement = await client.query(
    `SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', $1::text, $2::text) AS sql`,
    [role, password]
  );
  await client.query(statement.rows[0].sql);
  return verb === 'CREATE' ? 'CREATED' : 'UPDATED';
}

async function prepareDedicatedDatabase({
  client,
  confirmation,
  runtimeRole = null,
  runtimePassword = null,
  dbDir = path.join(__dirname, '..', 'db'),
  lockPath,
  log = () => {},
} = {}) {
  if (confirmation !== CONFIRMATION) throw new DedicatedDbMigrationError('CONFIRMATION_REQUIRED');
  if (!client || typeof client.query !== 'function') throw new TypeError('PostgreSQL client required');
  if (runtimeRole !== null || runtimePassword !== null) validateRuntimeRole(runtimeRole, runtimePassword);

  const locked = lockedMigrations({ dbDir, lockPath: lockPath || path.join(dbDir, 'migration-integrity-lock.json') });
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    const state = classifyExistingSchema(await publicTables(client));
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (
         sequence integer PRIMARY KEY CHECK (sequence >= 1),
         filename text NOT NULL UNIQUE,
         git_blob_sha1 text,
         state text NOT NULL CHECK (state IN ('STARTED','APPLIED')),
         started_at timestamptz NOT NULL DEFAULT now(),
         applied_at timestamptz
       )`
    );
    await client.query(`REVOKE ALL ON TABLE ${LEDGER} FROM PUBLIC`);
    const ledger = await client.query(`SELECT sequence, filename, git_blob_sha1, state FROM ${LEDGER}`);
    const pending = planPendingMigrations(locked, ledger.rows);
    log(`schema=${state} applied=${ledger.rows.length} pending=${pending.length}`);

    for (const migration of pending) {
      const sql = fs.readFileSync(path.join(dbDir, migration.file), 'utf8');
      await client.query(
        `INSERT INTO ${LEDGER} (sequence, filename, git_blob_sha1, state) VALUES ($1,$2,$3,'STARTED')`,
        [migration.sequence, migration.file, migration.sha1]
      );
      try {
        await client.query(sql);
      } catch (error) {
        // The migration file is a single BEGIN..COMMIT transaction: on error
        // PostgreSQL rolled it back, so the STARTED marker can be removed.
        await client.query('ROLLBACK').catch(() => {});
        await client.query(`DELETE FROM ${LEDGER} WHERE sequence=$1 AND state='STARTED'`, [migration.sequence]);
        throw new DedicatedDbMigrationError('MIGRATION_FAILED', { file: migration.file, sqlState: error.code || null });
      }
      await client.query(
        `UPDATE ${LEDGER} SET state='APPLIED', applied_at=now() WHERE sequence=$1`,
        [migration.sequence]
      );
      log(`applied ${migration.file}`);
    }

    let runtime = 'SKIPPED';
    if (runtimeRole !== null) runtime = await ensureRuntimeRole(client, runtimeRole, runtimePassword);
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    return Object.freeze({
      schema: state,
      applied: pending.map(item => item.file),
      totalApplied: ledger.rows.length + pending.length,
      lockedThrough: locked.length,
      runtimeRole: runtime,
      database,
    });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
  }
}

module.exports = {
  CONFIRMATION,
  DedicatedDbMigrationError,
  classifyExistingSchema,
  planPendingMigrations,
  validateRuntimeRole,
  prepareDedicatedDatabase,
};
