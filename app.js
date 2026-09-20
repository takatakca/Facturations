'use strict';

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/server');
const { createDraftStore } = require('./src/draft-store');

if (require.main === module) {
  const config = loadConfig();
  let draftStore = null;
  if (config.databaseUrl && config.businessId) {
    // Database module is required only for the dedicated app; no existing TAKATAK DB is accessed.
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    pool.on('error', () => { /* Do not log database connection strings, customer data or credentials. */ });
    draftStore = createDraftStore({ pool, businessId: config.businessId });
  }
  const server = createServer({ config, draftStore });
  server.listen(config.port, () => {
    console.info(`TAKATAK Wave Phase 3 listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, loadConfig };
