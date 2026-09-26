'use strict';

const { loadConfig } = require('../src/config');
const { assertProductionRuntime, ProductionReadinessError } = require('../src/production-readiness');

function main() {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
    throw new ProductionReadinessError('NODE_ENV_PRODUCTION_REQUIRED');
  }
  const config = loadConfig();
  const result = assertProductionRuntime({ config, env: process.env });
  if (!result.enforced || !result.ready) {
    throw new ProductionReadinessError('PRODUCTION_GATE_NOT_ENFORCED');
  }
  console.log('PASS: production configuration gate satisfied.');
  console.log('This validates configuration shape only; it is not deployment approval.');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'PRODUCTION_PREFLIGHT_FAILED';
    console.error('FAIL: production configuration gate — ' + code);
    process.exitCode = 1;
  }
}

module.exports = { main };
