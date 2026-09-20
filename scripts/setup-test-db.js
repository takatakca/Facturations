'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const raw = process.env.FACTURATIONS_TEST_DATABASE_URL;
  if (!raw) throw new Error('FACTURATIONS_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/facturations_test') {
    throw new Error('Refusing migration outside localhost/facturations_test');
  }
  const pool = new Pool({ connectionString: raw, connectionTimeoutMillis: 5000 });
  try {
    for (const migration of ['001_draft_storage.sql', '002_immutable_drafts_audit.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', migration), 'utf8');
      await pool.query(sql);
    }
    console.info('Isolated test schema initialized with immutable history protections');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Isolated test schema setup failed');
  process.exitCode = 1;
});
