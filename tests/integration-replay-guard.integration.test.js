'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createIntegrationReplayGuard,
  IntegrationReplayError,
} = require('../src/integration-replay-guard');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

test('real disposable PostgreSQL: integration jti is consumed once per tenant',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const businessId = 'replay-' + crypto.randomUUID();
    const foreignBusinessId = 'replay-foreign-' + crypto.randomUUID();
    const jti = 'integration-replay-' + crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60;

    try {
      const guard = createIntegrationReplayGuard({ pool, businessId });
      assert.equal(await guard.consume({ jti, expiresAt }), true);
      await assert.rejects(
        guard.consume({ jti, expiresAt }),
        error => error instanceof IntegrationReplayError &&
          error.code === 'INTEGRATION_TOKEN_REPLAY' &&
          error.statusCode === 401,
      );

      const foreign = createIntegrationReplayGuard({ pool, businessId: foreignBusinessId });
      assert.equal(await foreign.consume({ jti, expiresAt }), true);

      const stored = await pool.query(
        `SELECT business_id, encode(jti_hash, 'hex') AS digest
           FROM facturations_integration_token_uses
          WHERE business_id IN ($1,$2)
          ORDER BY business_id`,
        [businessId, foreignBusinessId],
      );
      assert.equal(stored.rows.length, 2);
      assert.equal(stored.rows.every(row => /^[a-f0-9]{64}$/.test(row.digest)), true);
      assert.equal(JSON.stringify(stored.rows).includes(jti), false);
    } finally {
      await pool.query(
        'DELETE FROM facturations_integration_token_uses WHERE business_id IN ($1,$2)',
        [businessId, foreignBusinessId],
      );
      await pool.end();
    }
  });
