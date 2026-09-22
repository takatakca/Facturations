'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { attachBrowserSubmittedWorkspaceGuard } = require('../src/browser-submitted-workspace-guard');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftWorkspaceStore } = require('../src/draft-workspace-store');
const { createWorkspaceSubmissionStore } = require('../src/workspace-submission-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const PASSWORD = 'fictional-navigation-password-2026';
const ORIGIN = 'https://facturations.example.test'; // Config only; transport below is loopback HTTP.

async function person(auth, invitations, role) {
  const member = await auth.createPendingStaff({
    email: 'navigation-' + crypto.randomUUID() + '@example.test', password: PASSWORD, role,
  });
  const invitation = await invitations.issueInvitation({ staffId: member.id });
  await invitations.redeemInvitation({ token: invitation.token, password: PASSWORD });
  return auth.authenticate({ email: member.email, password: PASSWORD });
}

function content() {
  return { currency: 'CAD',
    customer: { name: 'Fictional navigation', email: 'navigation-client@example.test' },
    invoiceDate: '2026-09-20', dueDate: '2026-10-20',
    lines: [{ description: 'Fictional service', quantity: 2, unitPriceCents: 1250,
      discountCents: 0, taxable: false }], taxes: [] };
}

test('navigation guard requires dedicated HTTPS configuration and a real pool', () => {
  const server = http.createServer((_request, response) => response.end('previous'));
  assert.throws(() => attachBrowserSubmittedWorkspaceGuard(server, {
    origin: 'http://facturations.example.test', pool: { query() {} }, businessId: 'synthetic',
  }), /Dedicated HTTPS/);
  assert.throws(() => attachBrowserSubmittedWorkspaceGuard(server, {
    origin: ORIGIN, pool: {}, businessId: 'synthetic',
  }), /PostgreSQL pool/);
  assert.equal(server.listeners('request').length, 1, 'Invalid setup must not modify the server');
});

test('PostgreSQL: only active original owner navigates from frozen workspace to immutable review',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, connectionTimeoutMillis: 5000 });
    const businessId = 'nav-' + crypto.randomUUID();
    const auth = createStaffAuthStore({ pool, businessId });
    const invitations = createStaffInvitationStore({ pool, businessId });
    const workspaces = createDraftWorkspaceStore({ pool, businessId });
    const submissions = createWorkspaceSubmissionStore({ pool, businessId });
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ORIGINAL_HANDLER');
    });
    let listening = false;
    try {
      const owner = await person(auth, invitations, 'OWNER');
      const otherOwner = await person(auth, invitations, 'OWNER');
      const staff = await person(auth, invitations, 'STAFF');
      const workspace = await workspaces.create({ token: owner.token,
        creationKey: crypto.randomBytes(16).toString('hex'), content: content() });
      attachBrowserSubmittedWorkspaceGuard(server, { origin: ORIGIN, pool, businessId });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      listening = true;
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const visit = (path, token = owner.token, extraHeaders = {}) => fetch(endpoint + path, {
        redirect: 'manual', headers: {
          ...(token ? { Cookie: '__Host-facturations-session=' + token } : {}), ...extraHeaders,
        },
      });
      const editor = `/internal/editor?lang=fr&id=${workspace.id}`;
      assert.equal((await visit(editor)).status, 200, 'Unsubmitted workspaces remain editable');
      const frozen = await submissions.submit({ confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY',
        workspaceId: workspace.id, sessionToken: owner.token, expectedRevision: 1,
        expectedTotalCents: 2500, expectedCustomerEmail: 'navigation-client@example.test' });
      for (const path of [editor,
        `/internal/editor?lang=en&id=${workspace.id}`,
        `/internal/submit/${workspace.id}?lang=en`,
        `/internal/workspaces/${workspace.id}/preview?lang=fr`]) {
        const response = await visit(path);
        assert.equal(response.status, 303, 'Submitted pages open immutable review');
        assert.equal(response.headers.get('location'),
          `/internal/review/${frozen.draftId}?lang=${path.includes('lang=en') ? 'en' : 'fr'}`);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal(await response.text(), '', 'No customer details in redirect response');
      }
      for (const token of [null, staff.token, otherOwner.token]) {
        assert.equal((await visit(editor, token)).status, 200,
          'Navigation guard must not disclose the owner-only draft link');
      }
      assert.equal((await visit(editor, owner.token, { Authorization: 'Bearer forbidden' })).status, 200);
      assert.equal((await visit(`/internal/editor?lang=fr&id=${workspace.id}&extra=1`)).status, 200);
      assert.equal((await visit('/internal/editor?lang=fr&id=not-a-uuid')).status, 200);
      assert.equal((await visit('/internal/recent-workspaces?lang=fr')).status, 200);
      await auth.revokeSession(owner.token);
      assert.equal((await visit(editor)).status, 200, 'Revoked session cannot navigate to private review');
    } finally {
      if (listening) await new Promise(resolve => server.close(resolve));
      await pool.end();
    }
  });
