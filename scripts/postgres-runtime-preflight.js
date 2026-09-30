'use strict';

const { Pool } = require('pg');
const {
  runPostgresRuntimeSecurityPreflight,
} = require('../src/postgres-runtime-security');
const {
  verifyRuntimePrivileges,
} = require('./verify-runtime-db-privileges');

async function runFullRuntimeDbPreflight({
  databaseUrl = process.env.FACTURATIONS_DATABASE_URL,
  securityPreflight = runPostgresRuntimeSecurityPreflight,
  privilegeVerifier = verifyRuntimePrivileges,
  poolFactory = options => new Pool(options),
} = {}) {
  const security = await securityPreflight({ databaseUrl });

  const pool = poolFactory({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });
  if (!pool || typeof pool.query !== 'function' || typeof pool.end !== 'function') {
    throw new TypeError('PostgreSQL pool factory returned invalid pool');
  }
  pool.on?.('error', () => { /* Never log connection details. */ });
  try {
    await privilegeVerifier({ pool });
  } finally {
    await pool.end();
  }

  return Object.freeze({ transport: security.transport });
}

async function main() {
  const result = await runFullRuntimeDbPreflight();
  console.info(
    'PASS: PostgreSQL runtime role satisfies least-privilege policy; transport=' +
    result.transport
  );
  console.info('No database role name, URL, host or credential is printed by this preflight.');
}

if (require.main === module) {
  main().catch(() => {
    console.error('FAIL: PostgreSQL runtime role does not satisfy least-privilege policy');
    process.exitCode = 1;
  });
}

module.exports = { main, runFullRuntimeDbPreflight };
