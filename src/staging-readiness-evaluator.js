'use strict';

const STATUS = new Set(['PASS', 'BLOCKED']);
const SHA = /^[a-f0-9]{40}$/u;
const REFERENCE = /^[A-Za-z0-9._:/#-]{3,200}$/u;

const GATES = Object.freeze({
  core_ci: 'CI_SYNTHETIC',
  browser_fr_en: 'CI_SYNTHETIC',
  mfa_postgres: 'CI_SYNTHETIC',
  backup_restore_ci: 'CI_SYNTHETIC',
  runtime_db_least_privilege: 'CI_SYNTHETIC',
  observability_redaction_ci: 'CI_SYNTHETIC',

  main_branch_protection: 'REAL_GITHUB',
  independent_human_review: 'HUMAN_REVIEW',

  staging_https_proxy: 'REAL_STAGING',
  staging_node_port_private: 'REAL_STAGING',
  staging_dedicated_database: 'REAL_STAGING',
  staging_runtime_db_role: 'REAL_STAGING',
  staging_backup_restore: 'REAL_STAGING',
  staging_logs_no_pii: 'REAL_STAGING',
  mfa_recovery_drill: 'REAL_STAGING',
  accessibility_mobile_review: 'REAL_STAGING',

  legal_issuer_validation: 'REGULATORY_REVIEW',
  tax_accounting_review: 'REGULATORY_REVIEW',
  privacy_retention_review: 'REGULATORY_REVIEW',

  wave_authorized_staging: 'REAL_PROVIDER',
  email_provider_staging: 'REAL_PROVIDER',
  email_signed_webhook: 'REAL_PROVIDER',
  payment_provider_staging: 'REAL_PROVIDER',

  ai_voice_safety_validation: 'SECURITY_REVIEW',
  vulnerability_review: 'SECURITY_REVIEW',
  hosting_signoff: 'HOSTING_SIGNOFF',
});

class StagingReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StagingReadinessError';
    this.code = code;
  }
}

function fail(code) {
  throw new StagingReadinessError(code);
}

function exactObject(value, expectedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function validateTimestamp(value, nowMs, maxAgeMs) {
  if (typeof value !== 'string') fail('INVALID_EVALUATED_AT');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('INVALID_EVALUATED_AT');
  if (parsed > nowMs + 300000) fail('EVIDENCE_FROM_FUTURE');
  if (nowMs - parsed > maxAgeMs) fail('EVIDENCE_PACKAGE_STALE');
}

function evaluateStagingReadiness(
  input,
  { expectedReleaseSha, now = Date.now(), maxAgeMs = 86400000 } = {}
) {
  exactObject(
    input,
    ['version', 'environment', 'releaseSha', 'evaluatedAt', 'gates'],
    'INVALID_READINESS_PACKAGE'
  );
  if (input.version !== 1) fail('UNSUPPORTED_READINESS_VERSION');
  if (input.environment !== 'staging') fail('STAGING_ENVIRONMENT_REQUIRED');
  if (typeof expectedReleaseSha !== 'string' || !SHA.test(expectedReleaseSha)) {
    fail('EXPECTED_RELEASE_SHA_REQUIRED');
  }
  if (!SHA.test(input.releaseSha)) fail('INVALID_RELEASE_SHA');
  if (input.releaseSha !== expectedReleaseSha) fail('RELEASE_SHA_MISMATCH');
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    fail('INVALID_EVALUATION_CLOCK');
  }
  validateTimestamp(input.evaluatedAt, now, maxAgeMs);

  exactObject(input.gates, Object.keys(GATES), 'GATE_INVENTORY_MISMATCH');

  const blocked = [];
  for (const [gateId, requiredScope] of Object.entries(GATES)) {
    const gate = input.gates[gateId];
    exactObject(gate, ['status', 'evidenceScope', 'reference'], 'INVALID_GATE_' + gateId);

    if (!STATUS.has(gate.status)) fail('INVALID_GATE_STATUS_' + gateId);
    if (typeof gate.reference !== 'string' || !REFERENCE.test(gate.reference)) {
      fail('INVALID_GATE_REFERENCE_' + gateId);
    }

    if (gate.status === 'PASS') {
      if (gate.evidenceScope !== requiredScope) {
        fail('INVALID_EVIDENCE_SCOPE_' + gateId);
      }
    } else {
      if (gate.evidenceScope !== 'NONE') {
        fail('BLOCKED_GATE_MUST_HAVE_NO_EVIDENCE_' + gateId);
      }
      blocked.push(gateId);
    }
  }

  return Object.freeze({
    decision: blocked.length === 0 ? 'GO' : 'NO-GO',
    releaseSha: input.releaseSha,
    evaluatedAt: input.evaluatedAt,
    totalGates: Object.keys(GATES).length,
    passedGates: Object.keys(GATES).length - blocked.length,
    blockedGates: Object.freeze(blocked),
  });
}

module.exports = {
  evaluateStagingReadiness,
  StagingReadinessError,
  STAGING_GATES: GATES,
};
