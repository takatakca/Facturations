'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runFullRuntimeDbPreflight,
} = require('../scripts/postgres-runtime-preflight');

test('target runtime DB preflight requires both transport/role safety and exact privilege matrix', async () => {
  const calls = [];
  let ended = false;
  const pool = {
    on() {},
    async query() { return { rows: [] }; },
    async end() { ended = true; },
  };

  const result = await runFullRuntimeDbPreflight({
    databaseUrl: 'postgresql://runtime:secret@example.test/facturations',
    securityPreflight: async ({ databaseUrl }) => {
      calls.push(['security', databaseUrl]);
      return { transport: 'TLS' };
    },
    privilegeVerifier: async ({ pool: received }) => {
      calls.push(['matrix', received === pool]);
      return { passed: true };
    },
    poolFactory: options => {
      calls.push(['pool', options.connectionString]);
      return pool;
    },
  });

  assert.deepEqual(result, { transport: 'TLS' });
  assert.deepEqual(calls, [
    ['security', 'postgresql://runtime:secret@example.test/facturations'],
    ['pool', 'postgresql://runtime:secret@example.test/facturations'],
    ['matrix', true],
  ]);
  assert.equal(ended, true);
});

test('target runtime DB preflight fails closed when exact privilege matrix rejects the role', async () => {
  let ended = false;
  const pool = {
    on() {},
    async query() { return { rows: [] }; },
    async end() { ended = true; },
  };
  const error = new Error('RUNTIME_DELETE_MATRIX_MISMATCH_invoice_drafts');
  error.code = 'RUNTIME_DELETE_MATRIX_MISMATCH_invoice_drafts';

  await assert.rejects(
    runFullRuntimeDbPreflight({
      databaseUrl: 'postgresql://runtime:secret@example.test/facturations',
      securityPreflight: async () => ({ transport: 'TLS' }),
      privilegeVerifier: async () => { throw error; },
      poolFactory: () => pool,
    }),
    received => received === error,
  );
  assert.equal(ended, true);
});

test('target runtime DB preflight never opens matrix verifier after security preflight failure', async () => {
  let poolCreated = false;
  const securityError = new Error('unsafe transport');

  await assert.rejects(
    runFullRuntimeDbPreflight({
      databaseUrl: 'postgresql://runtime:secret@example.test/facturations',
      securityPreflight: async () => { throw securityError; },
      privilegeVerifier: async () => {
        throw new Error('must not run');
      },
      poolFactory: () => {
        poolCreated = true;
        throw new Error('must not create');
      },
    }),
    received => received === securityError,
  );
  assert.equal(poolCreated, false);
});
