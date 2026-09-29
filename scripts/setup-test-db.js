'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { loadLock, verifyMigrationIntegrity } = require('./verify-migration-integrity');

async function main() {
  const raw = process.env.FACTURATIONS_TEST_DATABASE_URL;
  if (!raw) throw new Error('FACTURATIONS_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/facturations_test') {
    throw new Error('Refusing migration outside localhost/facturations_test');
  }
  verifyMigrationIntegrity();
  const migrations=loadLock().migrations.map(item=>item.file);
  const pool = new Pool({ connectionString: raw, connectionTimeoutMillis: 5000 });
  try {
    for (const migration of migrations) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', migration), 'utf8');
      await pool.query(sql);
    }
    console.info('Isolated test schema initialized with draft protection, staff invitations, login limits, MFA, revisioned workspaces, immutable submissions, customer contact history and issuance authorization gate and provider execution state and immutable issued invoice registry and immutable issued invoice PDF archive and verified versioned issuer profiles and issuer-bound qualified invoice PDFs and immutable delivery authorizations and persistent simulated delivery attempts and immutable simulated delivery receipts and append-only synthetic provider evidence and read-only evidence summary projection and verified signed webhook evidence provenance, payment projections and passwordless client portal auth and explicit portal publication authorization and offline OWNER MFA recovery ceremony and fail-closed synthetic-only payment evidence gate and provider transaction reuse guard');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Isolated test schema setup failed');
  process.exitCode = 1;
});
