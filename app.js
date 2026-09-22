'use strict';

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/server');
const { attachReadOnlyDashboardCookie } = require('./src/browser-dashboard-session');
const { attachBrowserStaffLogin } = require('./src/browser-staff-login');
const { attachBrowserWorkspaceRoutes } = require('./src/browser-workspace-routes');
const { attachBrowserWorkspaceEditor } = require('./src/browser-workspace-editor');
const { attachBrowserRecentWorkspaces } = require('./src/browser-recent-workspaces');
const { attachBrowserWorkspacePreview } = require('./src/browser-workspace-preview');
const { attachBrowserOwnerReview } = require('./src/browser-owner-review');
const { attachBrowserWorkspaceSubmission } = require('./src/browser-workspace-submission');
const { createRecentWorkspaceStore } = require('./src/recent-workspace-store');
const { createDraftStore } = require('./src/draft-store');
const { createDraftApprovalStore } = require('./src/draft-approval-store');
const { createWorkspaceSubmissionStore } = require('./src/workspace-submission-store');
const { createDraftWorkspaceStore } = require('./src/draft-workspace-store');
const { createDashboardStore } = require('./src/dashboard-store');
const { createStaffAuthStore } = require('./src/staff-auth-store');
const { createStaffTotpStore } = require('./src/staff-totp-store');
const { createLoginAttemptLimit } = require('./src/login-attempt-limit');
const { createCustomerDirectory } = require('./src/customer-directory');
const { createApprovalLedger } = require('./src/approval-ledger');

if (require.main === module) {
  const config = loadConfig();
  let draftStore = null;
  let dashboardStore = null;
  let staffAuthStore = null;
  let attemptLimit = null;
  let customerDirectory = null;
  let approvalLedger = null;
  let draftApprovalStore = null;
  let workspaceSubmissionStore = null;
  let workspaceStore = null;
  let recentStore = null;
  if (config.databaseUrl && config.businessId) {
    // Database module is required only for the dedicated app; no existing TAKATAK DB is accessed.
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    pool.on('error', () => { /* Do not log database connection strings, customer data or credentials. */ });
    draftStore = createDraftStore({ pool, businessId: config.businessId });
    dashboardStore = createDashboardStore({ pool, businessId: config.businessId });
    const totpStore = config.totpEncryptionKeyHex
      ? createStaffTotpStore({ pool, businessId: config.businessId,
        encryptionKeyHex: config.totpEncryptionKeyHex }) : null;
    staffAuthStore = createStaffAuthStore({ pool, businessId: config.businessId, totpStore });
    if (config.browserOrigin) {
      attemptLimit = createLoginAttemptLimit({ pool, businessId: config.businessId });
      workspaceStore = createDraftWorkspaceStore({ pool, businessId: config.businessId });
      recentStore = createRecentWorkspaceStore({ pool, businessId: config.businessId });
      draftApprovalStore = createDraftApprovalStore({ pool, businessId: config.businessId });
      workspaceSubmissionStore = createWorkspaceSubmissionStore({ pool, businessId: config.businessId });
    }
    customerDirectory = createCustomerDirectory({ pool, businessId: config.businessId });
    approvalLedger = createApprovalLedger({ pool, businessId: config.businessId });
  }
  const server = createServer({ config, draftStore, dashboardStore, staffAuthStore, customerDirectory, approvalLedger });
  if (config.browserOrigin) {
    // Wrap once per service; never pass the shared administrative key to the browser.
    attachBrowserStaffLogin(server, { origin: config.browserOrigin, staffAuthStore, attemptLimit });
    attachBrowserWorkspaceRoutes(server, { origin: config.browserOrigin,
      encryptionKeyHex: config.totpEncryptionKeyHex, staffAuthStore, workspaceStore });
    attachBrowserWorkspaceEditor(server, { origin: config.browserOrigin, staffAuthStore });
    attachBrowserRecentWorkspaces(server, { origin: config.browserOrigin, recentStore });
    attachBrowserWorkspacePreview(server, { origin: config.browserOrigin, workspaceStore, staffAuthStore });
    attachBrowserOwnerReview(server, { origin: config.browserOrigin,
      encryptionKeyHex: config.totpEncryptionKeyHex, businessId: config.businessId,
      staffAuthStore, dashboardStore, draftStore, approvalStore: draftApprovalStore });
    attachBrowserWorkspaceSubmission(server, { origin: config.browserOrigin,
      encryptionKeyHex: config.totpEncryptionKeyHex, businessId: config.businessId,
      staffAuthStore, workspaceStore, submissionStore: workspaceSubmissionStore });
  }
  attachReadOnlyDashboardCookie(server);
  server.listen(config.port, () => {
    console.info(`TAKATAK Wave development service listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, loadConfig };
