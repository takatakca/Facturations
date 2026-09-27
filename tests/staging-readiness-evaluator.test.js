'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateStagingReadiness,
  StagingReadinessError,
  STAGING_GATES,
} = require('../src/staging-readiness-evaluator');

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-09-26T20:00:00.000Z');

function completePackage() {
  const gates = {};
  for (const [gateId, evidenceScope] of Object.entries(STAGING_GATES)) {
    gates[gateId] = {
      status: 'PASS',
      evidenceScope,
      reference: 'evidence-' + gateId.replaceAll('_', '-'),
    };
  }
  return {
    version: 1,
    environment: 'staging',
    releaseSha: SHA,
    evaluatedAt: '2026-09-26T19:30:00.000Z',
    gates,
  };
}

function expectCode(fn, code) {
  assert.throws(
    fn,
    error => error instanceof StagingReadinessError && error.code === code
  );
}

test('complete exact-scope evidence returns GO', () => {
  const result = evaluateStagingReadiness(completePackage(), {
    expectedReleaseSha: SHA,
    now: NOW,
  });
  assert.equal(result.decision, 'GO');
  assert.equal(result.passedGates, result.totalGates);
  assert.deepEqual(result.blockedGates, []);
});

test('one blocked mandatory gate returns NO-GO without leaking evidence references', () => {
  const input = completePackage();
  input.gates.wave_authorized_staging = {
    status: 'BLOCKED',
    evidenceScope: 'NONE',
    reference: 'pending-wave-staging',
  };
  const result = evaluateStagingReadiness(input, {
    expectedReleaseSha: SHA,
    now: NOW,
  });
  assert.equal(result.decision, 'NO-GO');
  assert.deepEqual(result.blockedGates, ['wave_authorized_staging']);
  assert.equal(JSON.stringify(result).includes('pending-wave-staging'), false);
});

test('synthetic CI evidence cannot satisfy real staging/provider/human gates', () => {
  for (const gateId of [
    'main_branch_protection',
    'independent_human_review',
    'staging_https_proxy',
    'wave_authorized_staging',
    'email_provider_staging',
    'payment_provider_staging',
    'legal_issuer_validation',
    'vulnerability_review',
    'hosting_signoff',
  ]) {
    const input = completePackage();
    input.gates[gateId].evidenceScope = 'CI_SYNTHETIC';
    expectCode(
      () => evaluateStagingReadiness(input, { expectedReleaseSha: SHA, now: NOW }),
      'INVALID_EVIDENCE_SCOPE_' + gateId
    );
  }
});

test('release SHA mismatch, stale package and future package fail closed', () => {
  expectCode(
    () => evaluateStagingReadiness(completePackage(), {
      expectedReleaseSha: 'b'.repeat(40),
      now: NOW,
    }),
    'RELEASE_SHA_MISMATCH'
  );

  const stale = completePackage();
  stale.evaluatedAt = '2026-09-24T19:00:00.000Z';
  expectCode(
    () => evaluateStagingReadiness(stale, { expectedReleaseSha: SHA, now: NOW }),
    'EVIDENCE_PACKAGE_STALE'
  );

  const future = completePackage();
  future.evaluatedAt = '2026-09-26T20:10:01.000Z';
  expectCode(
    () => evaluateStagingReadiness(future, { expectedReleaseSha: SHA, now: NOW }),
    'EVIDENCE_FROM_FUTURE'
  );
});

test('missing or unexpected gates fail closed', () => {
  const missing = completePackage();
  delete missing.gates.core_ci;
  expectCode(
    () => evaluateStagingReadiness(missing, { expectedReleaseSha: SHA, now: NOW }),
    'GATE_INVENTORY_MISMATCH'
  );

  const extra = completePackage();
  extra.gates.unreviewed_new_gate = {
    status: 'PASS',
    evidenceScope: 'CI_SYNTHETIC',
    reference: 'unexpected-gate',
  };
  expectCode(
    () => evaluateStagingReadiness(extra, { expectedReleaseSha: SHA, now: NOW }),
    'GATE_INVENTORY_MISMATCH'
  );
});

test('blocked gate cannot carry a scope that looks like verified evidence', () => {
  const input = completePackage();
  input.gates.email_signed_webhook = {
    status: 'BLOCKED',
    evidenceScope: 'REAL_PROVIDER',
    reference: 'not-actually-complete',
  };
  expectCode(
    () => evaluateStagingReadiness(input, { expectedReleaseSha: SHA, now: NOW }),
    'BLOCKED_GATE_MUST_HAVE_NO_EVIDENCE_email_signed_webhook'
  );
});
