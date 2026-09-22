'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createCustomerContactStore, CustomerContactError } = require('../src/customer-contact-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const contact = (email, extra = {}) => ({ name: 'Client fictif', email, address: 'Adresse fictive', ...extra });

async function identity(auth, invitations, role) {
  const password = 'fictional-customer-password-2026';
  const user = await auth.createPendingStaff({ email: `${crypto.randomUUID()}@example.test`, password, role });
  const invite = await invitations.issueInvitation({ staffId: user.id });
  await invitations.redeemInvitation({ token: invite.token, password });
  const session = await auth.authenticate({ email: user.email, password });
  return { id: user.id, token: session.token };
}

test('customer contacts: isolated PostgreSQL create, audit, tenant isolation and revocation',
  { skip: !DATABASE }, async () => {
    const target = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
    assert.equal(target.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const tenant = `contact-${crypto.randomUUID()}`;
    const foreign = `contact-${crypto.randomUUID()}`;
    const email = `client-${crypto.randomUUID()}@example.test`;
    try {
      const auth = createStaffAuthStore({ pool, businessId: tenant });
      const invites = createStaffInvitationStore({ pool, businessId: tenant });
      const owner = await identity(auth, invites, 'OWNER');
      const staff = await identity(auth, invites, 'STAFF');
      const store = createCustomerContactStore({ pool, businessId: tenant });
      const other = createCustomerContactStore({ pool, businessId: foreign });
      const command = (who, fields, changes = {}) => ({ sessionToken: who.token, ownerId: who.id,
        ...fields, ...changes });
      const created = await store.saveContact(command(owner, contact(email)));
      assert.equal(created.action, 'CREATED');
      assert.equal(created.revision, 1);
      const first = await store.getContact(created.id);
      assert.equal(first.email, email);
      assert.equal(first.revision, 1);
      await assert.rejects(other.getContact(created.id), e => e instanceof CustomerContactError && e.statusCode === 404);
      await assert.rejects(store.saveContact(command(staff, contact(`staff-${crypto.randomUUID()}@example.test`))),
        e => e.code === 'OWNER_REQUIRED' && e.statusCode === 403);
      await assert.rejects(store.saveContact(command(owner, contact(email.toUpperCase()))),
        e => e.code === 'EMAIL_EXISTS' && e.statusCode === 409);
      const updated = await store.saveContact(command(owner, { ...contact(email, { name: 'Nom corrigé',
        address: 'Nouvelle adresse' }), id: created.id, expectedRevision: 1 }));
      assert.equal(updated.action, 'UPDATED');
      assert.equal(updated.revision, 2);
      assert.equal((await store.getContact(created.id)).name, 'Nom corrigé');
      await assert.rejects(store.saveContact(command(owner, { ...contact(email), id: created.id, expectedRevision: 1 })),
        e => e.code === 'REVISION_CONFLICT' && e.statusCode === 409);
      const events = await pool.query(
        'SELECT action, contact_revision FROM facturations_customer_contact_events WHERE business_id=$1 AND customer_id=$2 ORDER BY contact_revision',
        [tenant, created.id]);
      assert.deepEqual(events.rows, [{ action: 'CREATED', contact_revision: 1 },
        { action: 'UPDATED', contact_revision: 2 }]);
      assert.equal(await auth.revokeSession(owner.token), true);
      await assert.rejects(store.saveContact(command(owner, contact(`revoked-${crypto.randomUUID()}@example.test`))),
        e => e.code === 'OWNER_REQUIRED' && e.statusCode === 403);
    } finally { await pool.end(); }
  });
