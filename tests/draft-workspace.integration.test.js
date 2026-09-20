'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const isError = (code, statusCode) => error => error instanceof WorkspaceError &&
  error.code === code && error.statusCode === statusCode;
const content = notes => ({ currency: 'CAD', customer: { name: 'Fictional customer' },
  lines: [{ description: 'Synthetic service', quantity: 1, unitPriceCents: 1200 }], notes });

test('invalid workspace input is rejected before any storage access', async () => {
  const pool = { connect() { throw new Error('must not connect'); }, query() {} };
  const store = createDraftWorkspaceStore({ pool, businessId: 'synthetic-business' });
  const token = 'A'.repeat(43);
  await assert.rejects(store.create({ token, creationKey: 'short', content: {} }), isError('INVALID_CREATION_KEY', 422));
  await assert.rejects(store.create({ token, creationKey: 'c'.repeat(20), content: { status: 'ISSUED' } }),
    isError('INVALID_WORKSPACE_CONTENT', 422));
  await assert.rejects(store.create({ token, creationKey: 'c'.repeat(20), content: { currency: 'USD' } }),
    isError('INVALID_WORKSPACE_CONTENT', 422));
  await assert.rejects(store.create({ token, creationKey: 'c'.repeat(20), content: { notes: 'x'.repeat(30000) } }),
    isError('INVALID_WORKSPACE_CONTENT', 422));
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(store.create({ token, creationKey: 'c'.repeat(20), content: { customer: cyclic } }),
    isError('INVALID_WORKSPACE_CONTENT', 422));
  await assert.rejects(store.load({ token, workspaceId: 'wrong' }), isError('INVALID_WORKSPACE_ID', 422));
  await assert.rejects(store.save({ token, workspaceId: crypto.randomUUID(), expectedRevision: 0, content: {} }),
    isError('INVALID_REVISION', 422));
  await assert.rejects(store.load({ token: 'invalid', workspaceId: crypto.randomUUID() }),
    isError('UNAUTHORIZED', 401));
});

test('disposable PostgreSQL: owned workspace survives reload, retries and concurrent edits without rewriting invoice snapshots',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4, connectionTimeoutMillis: 5000 });
    const tenant = 'workspace-' + crypto.randomUUID();
    const foreignTenant = 'workspace-foreign-' + crypto.randomUUID();
    async function staff(businessId) {
      const row = await pool.query(
        `INSERT INTO facturations_staff_users
          (business_id,email_normalized,role,password_salt,password_hash,email_verified_at)
         VALUES ($1,$2,'STAFF',$3,$4,now()) RETURNING id`,
        [businessId, crypto.randomUUID() + '@example.test', Buffer.alloc(16), Buffer.alloc(64)]
      );
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO facturations_staff_sessions (business_id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,now()+interval '12 hours')`,
        [businessId, row.rows[0].id, crypto.createHash('sha256').update(token).digest()]
      );
      return { id: row.rows[0].id, token };
    }
    try {
      const owner = await staff(tenant);
      const colleague = await staff(tenant);
      const outsider = await staff(foreignTenant);
      const store = createDraftWorkspaceStore({ pool, businessId: tenant });
      const otherBusinessStore = createDraftWorkspaceStore({ pool, businessId: foreignTenant });
      const creationKey = crypto.randomUUID().replace(/-/g, '');
      const initial = content('Partially completed work');
      const [created, retry] = await Promise.all([
        store.create({ token: owner.token, creationKey, content: initial }),
        store.create({ token: owner.token, creationKey, content: initial }),
      ]);
      assert.equal(created.id, retry.id);
      assert.equal(created.revision, 1);
      assert.equal(created.status, 'WORK_IN_PROGRESS');
      assert.equal(created.invoiceIssued, false);
      assert.equal(created.emailed, false);
      assert.deepEqual((await store.load({ token: owner.token, workspaceId: created.id })).content, initial);
      await assert.rejects(store.create({ token: owner.token, creationKey, content: content('different') }),
        isError('WORKSPACE_CREATION_CONFLICT', 409));
      await assert.rejects(store.load({ token: colleague.token, workspaceId: created.id }),
        isError('WORKSPACE_NOT_FOUND', 404));
      await assert.rejects(store.save({ token: colleague.token, workspaceId: created.id,
        expectedRevision: 1, content: content('stolen') }), isError('WORKSPACE_NOT_FOUND', 404));
      await assert.rejects(otherBusinessStore.load({ token: outsider.token, workspaceId: created.id }),
        isError('WORKSPACE_NOT_FOUND', 404));
      await assert.rejects(store.load({ token: outsider.token, workspaceId: created.id }),
        isError('UNAUTHORIZED', 401));
      const [a, b] = await Promise.allSettled([
        store.save({ token: owner.token, workspaceId: created.id,
          expectedRevision: 1, content: content('edit A') }),
        store.save({ token: owner.token, workspaceId: created.id,
          expectedRevision: 1, content: content('edit B') }),
      ]);
      assert.equal([a, b].filter(result => result.status === 'fulfilled').length, 1);
      const rejected = [a, b].find(result => result.status === 'rejected');
      assert.ok(isError('WORKSPACE_REVISION_CONFLICT', 409)(rejected.reason));
      const latest = await store.load({ token: owner.token, workspaceId: created.id });
      assert.equal(latest.revision, 2);
      assert.ok(['edit A', 'edit B'].includes(latest.content.notes));
      assert.equal((await store.create({ token: owner.token, creationKey, content: initial })).revision, 2);
      const history = await pool.query(
        `SELECT revision,content FROM facturations_draft_workspace_revisions
          WHERE business_id=$1 AND workspace_id=$2 ORDER BY revision`, [tenant, created.id]);
      assert.deepEqual(history.rows.map(row => row.revision), [1, 2]);
      assert.deepEqual(history.rows[0].content, initial);
      assert.deepEqual(history.rows[1].content, latest.content);
      await assert.rejects(pool.query(
        `UPDATE facturations_draft_workspace_revisions SET content='{}'::jsonb
          WHERE business_id=$1 AND workspace_id=$2`, [tenant, created.id]), error => error.code === '23514');
      await assert.rejects(pool.query(
        `DELETE FROM facturations_draft_workspaces WHERE business_id=$1 AND id=$2`,
        [tenant, created.id]), error => error.code === '23514');
      await assert.rejects(pool.query(
        `UPDATE facturations_draft_workspaces SET content='{}'::jsonb
          WHERE business_id=$1 AND id=$2`, [tenant, created.id]), error => error.code === '23514');
      await assert.rejects(pool.query(
        `UPDATE facturations_draft_workspaces SET content='{}'::jsonb,revision=revision+1
          WHERE business_id=$1 AND id=$2`, [tenant, created.id]), error => error.code === '23514');
      const unchangedInvoiceCount = await pool.query('SELECT count(*)::integer AS n FROM invoice_drafts WHERE business_id=$1', [tenant]);
      assert.equal(unchangedInvoiceCount.rows[0].n, 0);
      await pool.query('UPDATE facturations_staff_sessions SET revoked_at=now() WHERE business_id=$1 AND user_id=$2',
        [tenant, owner.id]);
      await assert.rejects(store.load({ token: owner.token, workspaceId: created.id }),
        isError('UNAUTHORIZED', 401));
      await assert.rejects(store.save({ token: owner.token, workspaceId: created.id,
        expectedRevision: 2, content: content('post-revoke') }), isError('UNAUTHORIZED', 401));
      const afterRevocation = await pool.query(
        'SELECT revision,content FROM facturations_draft_workspaces WHERE business_id=$1 AND id=$2',
        [tenant, created.id]);
      assert.equal(afterRevocation.rows[0].revision, 2);
      assert.deepEqual(afterRevocation.rows[0].content, latest.content);
    } finally {
      await pool.end();
    }
  });
