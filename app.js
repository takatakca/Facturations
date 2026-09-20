'use strict';

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/server');

if (require.main === module) {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, () => {
    // Only non-sensitive startup information is logged.
    console.info(`TAKATAK Wave Phase 1 listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, loadConfig };
