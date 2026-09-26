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
    for (const migration of [
      '001_draft_storage.sql',
      '002_immutable_drafts_audit.sql',
      '003_staff_identity_sessions.sql',
      '004_staff_invitations.sql',
      '005_internal_draft_approvals.sql',
      '006_login_attempt_limits.sql',
      '007_staff_totp.sql',
      '008_draft_workspaces.sql',
      '009_workspace_submissions.sql',
      '010_customer_contact_changes.sql',
      '011_issuance_authorizations.sql',
      '012_provider_issuance_attempts.sql',
      '013_issued_invoice_registry.sql',
      '014_issued_invoice_documents.sql',
      '015_verified_issuer_profiles.sql',
      '016_invoice_issuer_binding_and_qualified_pdf.sql',
      '017_delivery_authorizations.sql',
      '018_delivery_attempts.sql',
      '019_delivery_receipts.sql',
      '020_email_provider_evidence.sql',
    ]) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', migration), 'utf8');
      await pool.query(sql);
    }
    console.info('Isolated test schema initialized with draft protection, staff invitations, login limits, MFA, revisioned workspaces, immutable submissions, customer contact history and issuance authorization gate and provider execution state and immutable issued invoice registry and immutable issued invoice PDF archive and verified versioned issuer profiles and issuer-bound qualified invoice PDFs and immutable delivery authorizations and persistent simulated delivery attempts and immutable simulated delivery receipts and append-only synthetic provider evidence');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Isolated test schema setup failed');
  process.exitCode = 1;
});
