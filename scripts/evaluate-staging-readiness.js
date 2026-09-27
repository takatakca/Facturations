'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  evaluateStagingReadiness,
  StagingReadinessError,
} = require('../src/staging-readiness-evaluator');

function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) throw new StagingReadinessError('EVIDENCE_FILE_REQUIRED');

  const expectedReleaseSha = String(process.env.FACTURATIONS_RELEASE_SHA || '').trim();
  const absolute = path.resolve(evidencePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const input = JSON.parse(raw);

  const result = evaluateStagingReadiness(input, { expectedReleaseSha });

  if (result.decision === 'GO') {
    console.log(
      'GO: staging evidence package passed ' +
      result.passedGates + '/' + result.totalGates + ' mandatory gates.'
    );
    return;
  }

  console.error(
    'NO-GO: ' + result.blockedGates.length + ' mandatory gate(s) blocked: ' +
    result.blockedGates.join(',')
  );
  process.exitCode = 2;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    const code = error instanceof StagingReadinessError
      ? error.code
      : 'STAGING_READINESS_EVALUATION_FAILED';
    console.error('FAIL: staging readiness evidence invalid — ' + code);
    process.exitCode = 1;
  }
}

module.exports = { main };
