'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createCustomerContactStore } = require('../src/customer-contact-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

test('contact editing refuses simultaneous overwrites and never changes an immutable draft snapshot',
  { skip: !DATABASE }, async () => {
    const target = new URL(DATABASE);
    assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
    assert.equal(target.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE, max: 4 });
    const tenant = `contact-race-${crypto.randomUUID()}`;
    const email = `original-${crypto.randomUUID()}@example.test`;
    const otherEmail = `other-${crypto.randomUUID()}@example.test`;
    const ownerEmail = `owner-${crypto.randomUUID()}@example.test`;
    const password = 'fictional-race-password-2026';
    try {
      const auth = createStaffAuthStore({ pool, businessId: tenant });
      const invitations = createStaffInvitationStore({ pool, businessId: tenant });
      const owner = await auth.createPendingStaff({ email: ownerEmail, password, role: 'OWNER' });
      const invite = await invitations.issueInvitation({ staffId: owner.id });
      await invitations.redeemInvitation({ token: invite.token, password });
      const session = await auth.authenticate({ email: ownerEmail, password });
      const contacts = createCustomerContactStore({ pool, businessId: tenant });
      const drafts = createDraftStore({ pool, businessId: tenant });
      const draft = await drafts.createDraft({ currency: 'CAD',
        customer: { name: 'Nom original', email, address: 'Adresse initiale' },
        invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Brouillon fictif',
        lines: [{ description: 'Service fictif', quantity: 1, unitPriceCents: 2500, taxable: false }], taxes: [] },
        crypto.randomBytes(16).toString('hex'));
      const before = await pool.query('SELECT snapshot FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [tenant, draft.id]);
      assert.equal(before.rows.length, 1);
      const original = await pool.query('SELECT id FROM invoice_customers WHERE business_id=$1 AND email_normalized=$2',
        [tenant, email]);
      assert.equal(original.rows.length, 1);
      const id = original.rows[0].id;
      const command = (name, recipient = email) => ({ sessionToken: session.token, ownerId: owner.id,
        id, expectedRevision: 1, name, email: recipient, address: 'Adresse modifiée' });
      const results = await Promise.allSettled([
        contacts.saveContact(command('Correction A')),
        contacts.saveContact(command('Correction B')),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected' &&
        result.reason?.code === 'REVISION_CONFLICT' && result.reason?.statusCode === 409).length, 1);
      const current = await contacts.getContact(id);
      assert.equal(current.revision, 2);
      assert.ok(['Correction A', 'Correction B'].includes(current.name));
      await contacts.saveContact({ sessionToken: session.token, ownerId: owner.id,
        name: 'Second client fictif', email: otherEmail, address: '' });
      await assert.rejects(contacts.saveContact({ ...command('Email en conflit', otherEmail), expectedRevision: 2 }),
        error => error?.code === 'EMAIL_EXISTS' && error.statusCode === 409);
      assert.equal((await contacts.getContact(id)).revision, 2);
      const after = await pool.query('SELECT snapshot,status FROM invoice_drafts WHERE business_id=$1 AND id=$2',
        [tenant, draft.id]);
      assert.deepEqual(after.rows[0].snapshot, before.rows[0].snapshot);
      assert.equal(after.rows[0].status, 'DRAFT');
      const history = await pool.query(
        'SELECT action,contact_revision FROM facturations_customer_contact_events WHERE business_id=$1 AND customer_id=$2 ORDER BY contact_revision',
        [tenant, id]);
      assert.deepEqual(history.rows, [{ action: 'UPDATED', contact_revision: 2 }]);
    } finally { await pool.end(); }
  });
