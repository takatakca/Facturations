'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readEvidenceFile,
  MAX_EVIDENCE_BYTES,
} = require('../scripts/evaluate-staging-readiness');
const { StagingReadinessError } = require('../src/staging-readiness-evaluator');

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturations-readiness-evidence-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function expectsCode(operation, code) {
  assert.throws(operation, error =>
    error instanceof StagingReadinessError &&
    error.code === code &&
    !String(error).includes('facturations-readiness-evidence-'));
}

test('staging evidence reader accepts bounded synthetic JSON', () => {
  withFixture(dir => {
    const filename = path.join(dir, 'evidence.json');
    const payload = { version: 1, environment: 'staging', releaseSha: 'a'.repeat(40) };
    fs.writeFileSync(filename, JSON.stringify(payload), 'utf8');
    assert.deepEqual(readEvidenceFile(filename), payload);
  });
});

test('staging evidence reader accepts exact byte cap but rejects one byte more', () => {
  withFixture(dir => {
    const filename = path.join(dir, 'evidence.json');
    const json = '{"version":1}';
    fs.writeFileSync(filename, json + ' '.repeat(MAX_EVIDENCE_BYTES - json.length));
    assert.deepEqual(readEvidenceFile(filename), { version: 1 });
    fs.appendFileSync(filename, 'x');
    expectsCode(() => readEvidenceFile(filename), 'EVIDENCE_FILE_TOO_LARGE');
  });
});

test('staging evidence reader rejects malformed UTF-8 and invalid JSON', () => {
  withFixture(dir => {
    const filename = path.join(dir, 'evidence.json');
    fs.writeFileSync(filename, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    expectsCode(() => readEvidenceFile(filename), 'EVIDENCE_FILE_INVALID_UTF8');
    fs.writeFileSync(filename, '{"bad":');
    expectsCode(() => readEvidenceFile(filename), 'EVIDENCE_JSON_INVALID');
  });
});

test('staging evidence reader refuses directories, symlinks and missing files', () => {
  withFixture(dir => {
    expectsCode(() => readEvidenceFile(dir), 'EVIDENCE_FILE_NOT_REGULAR');
    expectsCode(() => readEvidenceFile(path.join(dir, 'missing.json')), 'EVIDENCE_FILE_UNAVAILABLE');
    expectsCode(() => readEvidenceFile(''), 'EVIDENCE_FILE_REQUIRED');
    if (process.platform !== 'win32') {
      const target = path.join(dir, 'target.json');
      const link = path.join(dir, 'link.json');
      fs.writeFileSync(target, '{"version":1}');
      fs.symlinkSync(target, link);
      expectsCode(() => readEvidenceFile(link), 'EVIDENCE_FILE_NOT_REGULAR');
    }
  });
});
