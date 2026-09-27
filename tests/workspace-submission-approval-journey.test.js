'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftWorkspaceStore, WorkspaceError } = require('../src/draft-workspace-store');
const { createWorkspaceSubmissionStore, SubmissionError } = require('../src/workspace-submission-store');
const { createDraftApprovalStore, DraftApprovalError } = require('../src/draft-approval-store');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
test('one isolated PostgreSQL owner session: workspace, explicit submission, separate internal approval and no issuance',
  { skip: !DATABASE }, async () => {
    const url = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE });
    const businessId = 'linked-review-' + crypto.randomUUID();
    const password = 'fictional-linked-review-password-2026';
    const auth = createStaffAuthStore({ pool, businessId });
    const invites = createStaffInvitationStore({ pool, businessId });
    const spaces = createDraftWorkspaceStore({ pool, businessId });
    const submissions = createWorkspaceSubmissionStore({ pool, businessId });
    const approvals = createDraftApprovalStore({ pool, businessId });
    try {
      const owner = await auth.createPendingStaff({
        email: 'owner-' + crypto.randomUUID() + '@example.test', password, role: 'OWNER',
      });
      const invite = await invites.issueInvitation({ staffId: owner.id });
      await invites.redeemInvitation({ token: invite.token, password });
      const session = await auth.authenticate({ email: owner.email, password });
      const customerEmail = 'customer-' + crypto.randomUUID() + '@example.test';
      const content = { currency: 'CAD',
        customer: { name: 'Fictional customer', email: customerEmail, address: 'Example only' },
        invoiceDate: '2026-09-20', dueDate: '2026-10-20', notes: 'Internal test only',
        lines: [{ description: 'Example service', quantity: 2, unitPriceCents: 1250,
          discountCents: 0, taxable: true }],
        taxes: [{ code: 'EXAMPLE', label: 'Imaginary tax', rateMilliPercent: 9975 }],
      };
      const workspace = await spaces.create({ token: session.token,
        creationKey: crypto.randomBytes(16).toString('hex'), content });
      const command = { confirmation: 'CREATE_IMMUTABLE_DRAFT_ONLY', workspaceId: workspace.id,
        sessionToken: session.token, expectedRevision: workspace.revision,
        expectedTotalCents: 2749, expectedCustomerEmail: customerEmail };
      const frozen = await submissions.submit(command);
      assert.equal(frozen.issued, false);
      assert.equal(frozen.waveSynced, false);
      assert.equal(frozen.emailed, false);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1',
        [businessId])).rows[0].n, 0, 'Conversion cannot silently approve');
      const wrong = { confirmation: 'APPROVE_DRAFT_ONLY', draftId: frozen.draftId,
        ownerId: owner.id, sessionToken: session.token, expectedTotalCents: 2750,
        expectedCustomerEmail: customerEmail };
      await assert.rejects(approvals.approveDraft(wrong), error =>
        error instanceof DraftApprovalError && error.statusCode === 409);
      const approved = await approvals.approveDraft({ ...wrong, expectedTotalCents: 2749 });
      assert.equal(approved.status, 'APPROVED_INTERNAL_ONLY');
      assert.equal(approved.issued, false);
      assert.equal(approved.emailed, false);
      const retry = await approvals.approveDraft({ ...wrong, expectedTotalCents: 2749 });
      assert.equal(retry.id, approved.id);
      const duplicate = await submissions.submit(command);
      assert.equal(duplicate.draftId, frozen.draftId);
      assert.equal(duplicate.created, false);
      await assert.rejects(spaces.save({ token: session.token, workspaceId: workspace.id,
        expectedRevision: workspace.revision, content }), error =>
        error instanceof WorkspaceError && error.statusCode === 409);
      const [drafts, decisions, events, links] = await Promise.all([
        pool.query('SELECT status,snapshot FROM invoice_drafts WHERE business_id=$1', [businessId]),
        pool.query('SELECT count(*)::integer AS n FROM facturations_draft_approvals WHERE business_id=$1', [businessId]),
        pool.query('SELECT action FROM invoice_audit_events WHERE business_id=$1', [businessId]),
        pool.query('SELECT count(*)::integer AS n FROM facturations_workspace_submissions WHERE business_id=$1', [businessId]),
      ]);
      assert.equal(drafts.rows.length, 1);
      assert.equal(drafts.rows[0].status, 'DRAFT');
      assert.equal(drafts.rows[0].snapshot.totalCents, 2749);
      assert.equal(drafts.rows[0].snapshot.customer.email, customerEmail);
      assert.equal(decisions.rows[0].n, 1);
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].action, 'DRAFT_CREATED');
      assert.equal(links.rows[0].n, 1);
      await auth.revokeSession(session.token);
      await assert.rejects(submissions.submit(command), error =>
        error instanceof SubmissionError && error.statusCode === 403);
      await assert.rejects(approvals.approveDraft({ ...wrong, expectedTotalCents: 2749 }), error =>
        error instanceof DraftApprovalError && error.statusCode === 403);
    } finally {
      await pool.end();
    }
  });
