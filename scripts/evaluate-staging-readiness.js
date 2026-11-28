'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  evaluateStagingReadiness,
  StagingReadinessError,
} = require('../src/staging-readiness-evaluator');

const { TextDecoder } = require('node:util');
const MAX_EVIDENCE_BYTES = 65_536;

// Private evidence is operator-supplied; never stream unbounded data or follow
// a symlink into a secret-bearing path. Error codes never contain file content.
function readEvidenceFile(evidencePath) {
  if (typeof evidencePath !== 'string' || !evidencePath.trim()) {
    throw new StagingReadinessError('EVIDENCE_FILE_REQUIRED');
  }
  const absolute = path.resolve(evidencePath);
  let fd;
  try {
    const entry = fs.lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new StagingReadinessError('EVIDENCE_FILE_NOT_REGULAR');
    }
    if (entry.size > MAX_EVIDENCE_BYTES) {
      throw new StagingReadinessError('EVIDENCE_FILE_TOO_LARGE');
    }
    // O_NOFOLLOW also closes the lstat/open race on platforms that support it.
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new StagingReadinessError('EVIDENCE_FILE_NOT_REGULAR');
    if (stat.size > MAX_EVIDENCE_BYTES) {
      throw new StagingReadinessError('EVIDENCE_FILE_TOO_LARGE');
    }
    const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_EVIDENCE_BYTES) {
      throw new StagingReadinessError('EVIDENCE_FILE_TOO_LARGE');
    }
    let raw;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new StagingReadinessError('EVIDENCE_FILE_INVALID_UTF8');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new StagingReadinessError('EVIDENCE_JSON_INVALID');
    }
  } catch (error) {
    if (error instanceof StagingReadinessError) throw error;
    throw new StagingReadinessError('EVIDENCE_FILE_UNAVAILABLE');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) throw new StagingReadinessError('EVIDENCE_FILE_REQUIRED');

  const expectedReleaseSha = String(process.env.FACTURATIONS_RELEASE_SHA || '').trim();
  const input = readEvidenceFile(evidencePath);

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

module.exports = { main, readEvidenceFile, MAX_EVIDENCE_BYTES };
