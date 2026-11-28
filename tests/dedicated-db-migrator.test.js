'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DedicatedDbMigrationError,
  classifyExistingSchema,
  planPendingMigrations,
  validateRuntimeRole,
  prepareDedicatedDatabase,
} = require('../src/dedicated-db-migrator');

const locked = [
  { sequence: 1, file: '001_a.sql', sha1: 'a'.repeat(40) },
  { sequence: 2, file: '002_b.sql', sha1: 'b'.repeat(40) },
  { sequence: 3, file: '003_c.sql', sha1: 'c'.repeat(40) },
];
const applied = (sequence, state = 'APPLIED') => ({
  sequence, filename: locked[sequence - 1].file, git_blob_sha1: locked[sequence - 1].sha1, state,
});
const code = expected => error => error instanceof DedicatedDbMigrationError && error.code === expected;

test('schema classification refuses foreign (e.g. TAKATAK) and untracked databases', () => {
  assert.equal(classifyExistingSchema([]), 'FRESH');
  assert.equal(classifyExistingSchema(['facturations_schema_migrations']), 'TRACKED');
  assert.equal(classifyExistingSchema(['facturations_schema_migrations', 'invoice_drafts']), 'TRACKED');
  assert.throws(() => classifyExistingSchema(['profiles', 'clients']), code('FOREIGN_SCHEMA_DETECTED'));
  assert.throws(() => classifyExistingSchema(['_prisma_migrations']), code('FOREIGN_SCHEMA_DETECTED'));
  assert.throws(() => classifyExistingSchema(['facturations_schema_migrations', 'audit_logs']),
    code('FOREIGN_SCHEMA_DETECTED'));
  assert.throws(() => classifyExistingSchema(['invoice_drafts']), code('UNTRACKED_FACTURATIONS_SCHEMA'));
});

test('pending plan is the exact locked suffix; drift and interrupted runs fail closed', () => {
  assert.deepEqual(planPendingMigrations(locked, []).map(m => m.file), ['001_a.sql', '002_b.sql', '003_c.sql']);
  assert.deepEqual(planPendingMigrations(locked, [applied(2), applied(1)]).map(m => m.file), ['003_c.sql']);
  assert.deepEqual(planPendingMigrations(locked, [applied(1), applied(2), applied(3)]), []);
  assert.throws(() => planPendingMigrations(locked, [applied(2)]), code('MIGRATION_LEDGER_DRIFT'));
  assert.throws(() => planPendingMigrations(locked, [{ ...applied(1), filename: '001_x.sql' }]),
    code('MIGRATION_LEDGER_DRIFT'));
  assert.throws(() => planPendingMigrations(locked, [{ ...applied(1), git_blob_sha1: 'f'.repeat(40) }]),
    code('MIGRATION_CONTENT_DRIFT'));
  assert.throws(() => planPendingMigrations(locked, [applied(1), applied(2, 'STARTED')]),
    code('INTERRUPTED_MIGRATION'));
  assert.throws(() => planPendingMigrations(locked.slice(0, 1), [applied(1), applied(2)]),
    code('MIGRATION_LEDGER_DRIFT'));
});

test('runtime role and password policy', () => {
  assert.doesNotThrow(() => validateRuntimeRole('facturations_app', 'x'.repeat(24)));
  for (const role of ['postgres', 'public', 'Facturations', 'a', 'drop table;', '1abc']) {
    assert.throws(() => validateRuntimeRole(role, 'x'.repeat(24)), code('RUNTIME_ROLE_INVALID'));
  }
  assert.throws(() => validateRuntimeRole('facturations_app', 'short'), code('RUNTIME_PASSWORD_INVALID'));
  assert.throws(() => validateRuntimeRole('facturations_app', 'x'.repeat(23) + '\n'), code('RUNTIME_PASSWORD_INVALID'));
});

test('explicit confirmation is required before any database access', async () => {
  const client = { query() { throw new Error('must not query'); } };
  await assert.rejects(prepareDedicatedDatabase({ client }), code('CONFIRMATION_REQUIRED'));
  await assert.rejects(prepareDedicatedDatabase({ client, confirmation: 'yes' }), code('CONFIRMATION_REQUIRED'));
  await assert.rejects(prepareDedicatedDatabase({ client, confirmation: 'APPLY_FACTURATIONS_MIGRATIONS',
    runtimeRole: 'postgres', runtimePassword: 'x'.repeat(30) }), code('RUNTIME_ROLE_INVALID'));
});
