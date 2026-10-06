'use strict';

// Operator command (server console only):
//   node scripts/prepare-dedicated-database.js --confirm=APPLY_FACTURATIONS_MIGRATIONS
//
// Environment (never commit these values):
//   FACTURATIONS_MIGRATION_DATABASE_URL  owner/migrator URL of the DEDICATED database
//   FACTURATIONS_RUNTIME_DB_ROLE         optional runtime LOGIN role (e.g. facturations_app)
//   FACTURATIONS_RUNTIME_DB_PASSWORD     its password (>= 24 characters), required with the role
//
// Applies the locked migrations, then (when a runtime role is given) creates
// or updates that role and applies ops/runtime-db-grants.sql through psql.
// Prints no URL, host, role password or credential.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { CONFIRMATION, prepareDedicatedDatabase } = require('../src/dedicated-db-migrator');

function argument(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function psqlEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  const env = {
    PATH: process.env.PATH,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode === 'no-verify' ? 'require' : sslmode;
  return env;
}

async function main() {
  const databaseUrl = (process.env.FACTURATIONS_MIGRATION_DATABASE_URL || '').trim();
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new Error('FACTURATIONS_MIGRATION_DATABASE_URL (PostgreSQL URL) is required');
  }
  if (databaseUrl === (process.env.FACTURATIONS_DATABASE_URL || '').trim()) {
    throw new Error('The migration URL must differ from the runtime FACTURATIONS_DATABASE_URL');
  }
  const runtimeRole = (process.env.FACTURATIONS_RUNTIME_DB_ROLE || '').trim() || null;
  const runtimePassword = process.env.FACTURATIONS_RUNTIME_DB_PASSWORD || null;

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  client.on('error', () => { /* Never print connection details. */ });
  await client.connect();
  let result;
  try {
    result = await prepareDedicatedDatabase({
      client,
      confirmation: argument('confirm'),
      runtimeRole,
      runtimePassword: runtimeRole ? runtimePassword : null,
      log: line => console.info(line),
    });
  } finally {
    await client.end();
  }

  if (runtimeRole) {
    const grants = spawnSync('psql', [
      '-X', '-q',
      '-v', 'ON_ERROR_STOP=1',
      '-v', `runtime_role=${runtimeRole}`,
      '-v', `database_name=${result.database}`,
      '-f', path.join(__dirname, '..', 'ops', 'runtime-db-grants.sql'),
    ], { env: psqlEnvironment(databaseUrl), encoding: 'utf8' });
    if (grants.status !== 0) {
      throw new Error('Runtime grants failed (psql exit ' + grants.status + ')');
    }
  }

  console.info(`PASS: dedicated database ready — migrations ${result.totalApplied}/${result.lockedThrough} applied` +
    ` (${result.applied.length} new); runtime role ${result.runtimeRole}` +
    (runtimeRole ? '; least-privilege grants applied' : ''));
  console.info('Next: start the app with FACTURATIONS_DATABASE_URL set to the RUNTIME role, then run `npm run check:runtime-db`.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FAIL: ' + (error && error.code ? error.code : error.message || 'prepare failed') +
      (error && error.detail ? ' ' + JSON.stringify(error.detail) : ''));
    console.error(`Usage: node scripts/prepare-dedicated-database.js --confirm=${CONFIRMATION}`);
    process.exitCode = 1;
  });
}

module.exports = { psqlEnvironment };
