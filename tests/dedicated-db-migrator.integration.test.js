'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { loadLock } = require('../scripts/verify-migration-integrity');
const { DedicatedDbMigrationError, prepareDedicatedDatabase } = require('../src/dedicated-db-migrator');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const CONFIRM = 'APPLY_FACTURATIONS_MIGRATIONS';
const code = expected => error => error instanceof DedicatedDbMigrationError && error.code === expected;

function urlFor(name) {
  const url = new URL(DATABASE);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDatabase(run) {
  const name = `facturations_test_migrator_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: DATABASE });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

test('dedicated database preparation on disposable PostgreSQL', { skip: !DATABASE }, async (t) => {
  const url = new URL(DATABASE);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  const total = loadLock().migrations.length;

  await t.test('fresh database: applies every locked migration once, then is idempotent', async () => {
    await withScratchDatabase(async (client) => {
      const first = await prepareDedicatedDatabase({ client, confirmation: CONFIRM });
      assert.equal(first.schema, 'FRESH');
      assert.equal(first.applied.length, total);
      assert.equal(first.totalApplied, total);
      assert.equal(first.runtimeRole, 'SKIPPED');
      const again = await prepareDedicatedDatabase({ client, confirmation: CONFIRM });
      assert.equal(again.schema, 'TRACKED');
      assert.deepEqual(again.applied, []);
      const ledger = await client.query('SELECT count(*)::integer AS n FROM facturations_schema_migrations WHERE state=$1', ['APPLIED']);
      assert.equal(ledger.rows[0].n, total);
      const drafts = await client.query("SELECT to_regclass('public.invoice_drafts') AS t");
      assert.equal(drafts.rows[0].t, 'invoice_drafts');
    });
  });

  await t.test('runtime role is created least-privileged and its password can be rotated', async () => {
    await withScratchDatabase(async (client) => {
      const role = `fact_rt_${crypto.randomBytes(4).toString('hex')}`;
      try {
        const created = await prepareDedicatedDatabase({ client, confirmation: CONFIRM,
          runtimeRole: role, runtimePassword: crypto.randomBytes(24).toString('base64url') });
        assert.equal(created.runtimeRole, 'CREATED');
        const attrs = await client.query(
          'SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
          [role]);
        assert.deepEqual(attrs.rows[0], { rolcanlogin: true, rolsuper: false, rolcreatedb: false,
          rolcreaterole: false, rolreplication: false, rolbypassrls: false });
        const updated = await prepareDedicatedDatabase({ client, confirmation: CONFIRM,
          runtimeRole: role, runtimePassword: crypto.randomBytes(24).toString('base64url') });
        assert.equal(updated.runtimeRole, 'UPDATED');
      } finally {
        await client.query(`DROP ROLE IF EXISTS ${role}`);
      }
    });
  });

  await t.test('refuses a foreign (TAKATAK-like) database without touching it', async () => {
    await withScratchDatabase(async (client) => {
      await client.query('CREATE TABLE profiles (id uuid PRIMARY KEY)');
      await assert.rejects(prepareDedicatedDatabase({ client, confirmation: CONFIRM }), code('FOREIGN_SCHEMA_DETECTED'));
      const ledger = await client.query("SELECT to_regclass('public.facturations_schema_migrations') AS t");
      assert.equal(ledger.rows[0].t, null);
    });
  });

  await t.test('refuses an interrupted run and a schema created outside the ledger', async () => {
    await withScratchDatabase(async (client) => {
      await prepareDedicatedDatabase({ client, confirmation: CONFIRM });
      await client.query("UPDATE facturations_schema_migrations SET state='STARTED' WHERE sequence=$1", [total]);
      await assert.rejects(prepareDedicatedDatabase({ client, confirmation: CONFIRM }), code('INTERRUPTED_MIGRATION'));
    });
    const legacy = new Client({ connectionString: DATABASE });
    await legacy.connect();
    try {
      // The shared test database was built by setup-test-db.js, without a ledger.
      await assert.rejects(prepareDedicatedDatabase({ client: legacy, confirmation: CONFIRM }),
        code('UNTRACKED_FACTURATIONS_SCHEMA'));
    } finally {
      await legacy.end();
    }
  });
});
