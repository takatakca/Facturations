'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');

const TOKEN = 'S'.repeat(43);
const ID = '22222222-2222-4222-8222-222222222222';
const CONTENT = { currency: 'CAD', customer: { name: 'Fictional only' }, lines: [], taxes: [] };
function poolFor(sqlError) {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('SELECT u.id FROM facturations_staff_sessions')) {
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
    }
    if (sql.includes('UPDATE facturations_draft_workspaces')) throw sqlError;
    return { rows: [] };
  }, release() { calls.push('RELEASE'); } };
  return { calls, connect: async () => client, query: async () => ({ rows: [] }) };
}

test('submitted workspace conflict returns 409, rolls back and does not expose database text', async () => {
  const pool = poolFor({ code: '23514', message: 'submitted workspace is frozen' });
  await assert.rejects(createDraftWorkspaceStore({ pool, businessId: 'fictional-tenant' }).save({
    token: TOKEN, workspaceId: ID, expectedRevision: 1, content: CONTENT,
  }), error => error instanceof WorkspaceError && error.code === 'WORKSPACE_SUBMITTED' && error.statusCode === 409);
  assert.ok(pool.calls.includes('ROLLBACK'));
  assert.ok(pool.calls.includes('RELEASE'));
});

test('unrelated database errors stay sanitized as unavailable, not submitted conflicts', async () => {
  const pool = poolFor({ code: '23514', message: 'unrelated database constraint' });
  await assert.rejects(createDraftWorkspaceStore({ pool, businessId: 'fictional-tenant' }).save({
    token: TOKEN, workspaceId: ID, expectedRevision: 1, content: CONTENT,
  }), error => error instanceof WorkspaceError && error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503);
});
