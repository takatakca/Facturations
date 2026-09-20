'use strict';

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/server');
const { attachReadOnlyDashboardCookie } = require('./src/browser-dashboard-session');
const { attachBrowserStaffLogin } = require('./src/browser-staff-login');
const { createDraftStore } = require('./src/draft-store');
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
    if (config.browserOrigin) attemptLimit = createLoginAttemptLimit({ pool, businessId: config.businessId });
    customerDirectory = createCustomerDirectory({ pool, businessId: config.businessId });
    approvalLedger = createApprovalLedger({ pool, businessId: config.businessId });
  }
  const server = createServer({ config, draftStore, dashboardStore, staffAuthStore, customerDirectory, approvalLedger });
  if (config.browserOrigin) {
    // This wrapper must precede the read-only dashboard cookie listener.
    // Browser login stays absent unless HTTPS origin, separate key and DB are configured.
    attachBrowserStaffLogin(server, { origin: config.browserOrigin, staffAuthStore, attemptLimit });
  }
  attachReadOnlyDashboardCookie(server);
  server.listen(config.port, () => {
    console.info(`TAKATAK Wave development service listening on port ${server.address().port}`);
  });
}

module.exports = { createServer, loadConfig };
