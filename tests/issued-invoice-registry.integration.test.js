'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createProviderExecutionStore } = require('../src/provider-execution-store');
const { createWaveCreateConfirmationStore } = require('../src/wave-create-confirmation-store');
const {
  createIssuedInvoiceRegistry,
  IssuedInvoiceRegistryError,
} = require('../src/issued-invoice-registry');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function fixture(pool, businessId) {
  const password = 'fictional-issued-registry-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invites = createStaffInvitationStore({ pool, businessId });
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invites.issueInvitation({ staffId: owner.id });
  await invites.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });

  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const executions = createProviderExecutionStore({ pool, businessId });
  const confirmations = createWaveCreateConfirmationStore({ pool, businessId });
  const registry = createIssuedInvoiceRegistry({ pool, businessId });

  const customerEmail = 'customer-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: {
      name: 'Synthetic issued customer',
      email: customerEmail,
      address: 'Example only',
    },
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    notes: 'Issued registry synthetic fixture only',
    lines: [{
      description: 'Synthetic issued service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'issued_registry_' + crypto.randomBytes(12).toString('hex'));

  await approvals.approveDraft({
    confirmation: 'APPROVE_DRAFT_ONLY',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: customerEmail,
  });

  const authorization = await authorizations.authorize({
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: customerEmail,
    provider: 'WAVE',
  });

  const prepared = await executions.prepare({
    authorizationId: authorization.id,
    draftId: draft.id,
    provider: 'WAVE',
  });
  const started = await executions.begin({
    executionId: prepared.id,
    expectedVersion: prepared.version,
  });

  return {
    auth,
    draft,
    authorization,
    started,
    executions,
    confirmations,
    registry,
  };
}

test('only a CONFIRMED provider execution can materialize one immutable issued invoice', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issued-registry-' + crypto.randomUUID();

  try {
    const ctx = await fixture(pool, businessId);

    await assert.rejects(
      ctx.registry.materialize({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
        executionId: ctx.started.id,
      }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ISSUANCE_CHAIN_NOT_CONFIRMED' &&
        error.statusCode === 409,
      'IN_PROGRESS must never become a local issued invoice'
    );

    const create = await ctx.confirmations.save({
      executionId: ctx.started.id,
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      providerInvoiceId: 'wave-issued-registry-synthetic',
      providerInvoiceNumber: 'SYNTHETIC-DRAFT-4001',
    });
    assert.equal(create.providerInvoiceId, 'wave-issued-registry-synthetic');

    await assert.rejects(
      ctx.registry.materialize({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
        executionId: ctx.started.id,
      }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ISSUANCE_CHAIN_NOT_CONFIRMED' &&
        error.statusCode === 409,
      'persisted CREATE alone is still not issuance'
    );

    const confirmed = await ctx.executions.recordOutcome({
      executionId: ctx.started.id,
      expectedVersion: ctx.started.version,
      outcome: 'CONFIRMED',
      providerInvoiceId: 'wave-issued-registry-synthetic',
      officialInvoiceNumber: 'SYNTHETIC-4001',
      errorCode: null,
    });
    assert.equal(confirmed.state, 'CONFIRMED');

    const issued = await ctx.registry.materialize({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      executionId: ctx.started.id,
    });
    assert.equal(issued.status, 'ISSUED_CONFIRMED');
    assert.equal(issued.deliveryState, 'NOT_AUTHORIZED');
    assert.equal(issued.provider, 'WAVE');
    assert.equal(issued.providerInvoiceId, 'wave-issued-registry-synthetic');
    assert.equal(issued.officialInvoiceNumber, 'SYNTHETIC-4001');
    assert.equal(issued.snapshot.totalCents, 3000);
    assert.match(issued.snapshot.customer.email, /@example\.test$/);

    const repeated = await ctx.registry.materialize({
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      executionId: ctx.started.id,
    });
    assert.equal(repeated.id, issued.id, 'materialization is idempotent');

    const loaded = await ctx.registry.getByDraft(ctx.draft.id);
    assert.equal(loaded.id, issued.id);
    assert.equal(loaded.deliveryState, 'NOT_AUTHORIZED');

    const localDraft = await pool.query(
      'SELECT status,snapshot FROM invoice_drafts WHERE business_id=$1 AND id=$2',
      [businessId, ctx.draft.id]
    );
    assert.equal(localDraft.rows[0].status, 'DRAFT',
      'issued registry never rewrites the immutable source draft');
    assert.equal(localDraft.rows[0].snapshot.totalCents, 3000);

    const rows = await pool.query(
      `SELECT count(*)::integer AS n,status,delivery_state
         FROM facturations_issued_invoices
        WHERE business_id=$1 AND draft_id=$2
        GROUP BY status,delivery_state`,
      [businessId, ctx.draft.id]
    );
    assert.equal(rows.rows[0].n, 1);
    assert.equal(rows.rows[0].status, 'ISSUED_CONFIRMED');
    assert.equal(rows.rows[0].delivery_state, 'NOT_AUTHORIZED');

    await assert.rejects(
      pool.query(
        `UPDATE facturations_issued_invoices
            SET delivery_state='NOT_AUTHORIZED'
          WHERE business_id=$1 AND draft_id=$2`,
        [businessId, ctx.draft.id]
      ),
      error => error.code === '23514',
      'issued registry is append-only'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issued_invoices WHERE business_id=$1 AND draft_id=$2',
        [businessId, ctx.draft.id]
      ),
      error => error.code === '23514',
      'issued registry cannot be deleted'
    );

    const otherTenant = createIssuedInvoiceRegistry({
      pool,
      businessId: 'other-' + crypto.randomUUID(),
    });
    await assert.rejects(
      otherTenant.getByDraft(ctx.draft.id),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ISSUED_INVOICE_NOT_FOUND' &&
        error.statusCode === 404,
      'cross-tenant read cannot discover the issued invoice'
    );
  } finally {
    await pool.end();
  }
});

test('materialization rejects a provider invoice id that does not match persisted CREATE evidence', {
  skip: !DATABASE,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'issued-registry-mismatch-' + crypto.randomUUID();

  try {
    const ctx = await fixture(pool, businessId);
    await ctx.confirmations.save({
      executionId: ctx.started.id,
      authorizationId: ctx.authorization.id,
      draftId: ctx.draft.id,
      providerInvoiceId: 'wave-create-evidence-a',
      providerInvoiceNumber: 'SYNTHETIC-DRAFT-A',
    });
    await ctx.executions.recordOutcome({
      executionId: ctx.started.id,
      expectedVersion: ctx.started.version,
      outcome: 'CONFIRMED',
      providerInvoiceId: 'wave-different-confirmed-b',
      officialInvoiceNumber: 'SYNTHETIC-B',
      errorCode: null,
    });

    await assert.rejects(
      ctx.registry.materialize({
        authorizationId: ctx.authorization.id,
        draftId: ctx.draft.id,
        executionId: ctx.started.id,
      }),
      error => error instanceof IssuedInvoiceRegistryError &&
        error.code === 'ISSUANCE_CHAIN_NOT_CONFIRMED' &&
        error.statusCode === 409
    );
    const count = await pool.query(
      'SELECT count(*)::integer AS n FROM facturations_issued_invoices WHERE business_id=$1',
      [businessId]
    );
    assert.equal(count.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
