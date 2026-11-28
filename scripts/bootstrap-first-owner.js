'use strict';

// Operator command (server console only, owner present):
//   node scripts/bootstrap-first-owner.js --email=owner@example.test \
//     --verified-by="owner present at console, 2026-10-06" --confirm=BOOTSTRAP_FIRST_OWNER
//   node scripts/bootstrap-first-owner.js --email=owner@example.test --confirm-code=123456
//   node scripts/bootstrap-first-owner.js --email=owner@example.test --rotate-pending-secret
//
// Environment: FACTURATIONS_MIGRATION_DATABASE_URL (owner/migrator URL of the
// dedicated database), WAVE_BUSINESS_ID, FACTURATIONS_TOTP_ENCRYPTION_KEY.
// The generated password and TOTP secret are printed ONCE to this console.

const readline = require('node:readline');
const { Pool } = require('pg');
const {
  CONFIRMATION,
  bootstrapFirstOwner,
  confirmFirstOwnerTotp,
  rotatePendingFirstOwnerTotp,
} = require('../src/first-owner-bootstrap');

function argument(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

function printSecret(result) {
  console.info('');
  console.info('Add this account to an authenticator app (Google Authenticator, 1Password, Authy…):');
  console.info('  Account : ' + result.email);
  console.info('  Key     : ' + result.totpSecret);
  console.info('  URI     : ' + result.otpauthUri);
  console.info('This key is shown ONCE. Never paste it into chat, email, GitHub or tickets.');
}

async function confirmInteractively(context, email) {
  if (!process.stdin.isTTY) {
    console.info(`\nThen run: node scripts/bootstrap-first-owner.js --email=${email} --confirm-code=<6 digits>`);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const code = await ask('\nEnter the 6-digit code shown by the authenticator app: ');
    try {
      await confirmFirstOwnerTotp({ ...context, email, code });
      console.info('PASS: two-factor authentication is active. The owner can now sign in at /internal/login.');
      return;
    } catch (error) {
      if (error.code !== 'TOTP_CODE_INVALID') throw error;
      console.info('That code was not accepted (wait for the next code and check the phone clock).');
    }
  }
  console.info(`Not activated yet. Retry later with --confirm-code, or --rotate-pending-secret if the key was lost.`);
}

async function main() {
  const databaseUrl = (process.env.FACTURATIONS_MIGRATION_DATABASE_URL || '').trim();
  const businessId = (process.env.WAVE_BUSINESS_ID || '').trim();
  const encryptionKeyHex = (process.env.FACTURATIONS_TOTP_ENCRYPTION_KEY || '').trim();
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl) || !businessId || !/^[a-f0-9]{64}$/iu.test(encryptionKeyHex)) {
    throw new Error('FACTURATIONS_MIGRATION_DATABASE_URL, WAVE_BUSINESS_ID and FACTURATIONS_TOTP_ENCRYPTION_KEY are required');
  }
  const email = argument('email');
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10000 });
  pool.on('error', () => { /* Never print connection details. */ });
  const context = { pool, businessId, encryptionKeyHex };
  try {
    const code = argument('confirm-code');
    if (code !== null) {
      await confirmFirstOwnerTotp({ ...context, email, code });
      console.info('PASS: two-factor authentication is active. The owner can now sign in at /internal/login.');
      return;
    }
    if (flag('rotate-pending-secret')) {
      const rotated = await rotatePendingFirstOwnerTotp({ ...context, email });
      printSecret(rotated);
      await confirmInteractively(context, rotated.email);
      return;
    }
    const created = await bootstrapFirstOwner({
      ...context,
      email,
      confirmation: argument('confirm'),
      verificationReference: argument('verified-by'),
    });
    console.info('PASS: first OWNER created for this dedicated Facturations business.');
    console.info('  Email    : ' + created.email);
    console.info('  Password : ' + created.password);
    console.info('Store this password in a password manager now. It is shown ONCE.');
    printSecret(created);
    await confirmInteractively(context, created.email);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FAIL: ' + (error && error.code ? error.code : error.message || 'bootstrap failed'));
    console.error(`First run needs: --email=… --verified-by="…" --confirm=${CONFIRMATION}`);
    process.exitCode = 1;
  });
}
