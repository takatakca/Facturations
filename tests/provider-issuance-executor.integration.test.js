'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const {
  createProviderIssuanceAttemptStore,
  ProviderIssuanceAttemptError,
} = require('../src/provider-issuance-attempt-store');
const {
  createProviderIssuanceExecutor,
  ProviderIssuanceExecutorError,
} = require('../src/provider-issuance-executor');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provisionOwner({ auth, invitations, password }) {
  const owner = await auth.createPendingStaff({
    email: 'owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invitations.issueInvitation({ staffId: owner.id });
  await invitations.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

async function authorizedDraft({ drafts, approvals, authorizations, owner, session, suffix }) {
  const email = 'customer-' + suffix + '-' + crypto.randomUUID() + '@example.test';
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: { name: 'Synthetic ' + suffix, email, address: 'Example only' },
    invoiceDate: '2026-09-25',
    dueDate: '2026-10-25',
    notes: 'Provider execution test only',
    lines: [{
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  }, 'provider_' + crypto.randomBytes(16).toString('hex'));

  await approvals.approveDraft({
    confirmation: 'APPROVE_DRAFT_ONLY',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: email,
  });

  const authorization = await authorizations.authorize({
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: 3000,
    expectedCustomerEmail: email,
    provider: 'WAVE',
  });

  const payload = buildWaveIssuancePreflight({
    businessId: 'wave-business-example',
    customerId: 'wave-customer-' + suffix,
    productIds: ['wave-product-' + suffix],
    salesTaxes: {},
    snapshot: draft.preview,
  });
  return { draft, authorization, payload };
}

test('persistent provider engine confirms, blocks ambiguous retry, and reconciles without any real Wave call', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'provider-engine-' + crypto.randomUUID();
  const password = 'synthetic-provider-engine-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invitations, password });

    const confirmedFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'confirmed',
    });

    const crossFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'cross-lineage',
    });

    await assert.rejects(
      pool.query(
        `INSERT INTO facturations_provider_issuance_attempts
           (business_id,authorization_id,draft_id,provider,operation_key,state)
         VALUES ($1,$2,$3,'WAVE',$4,'PREPARED')`,
        [
          businessId,
          crossFixture.authorization.id,
          confirmedFixture.draft.id,
          'wave_' + crypto.randomBytes(32).toString('base64url'),
        ]
      ),
      error => error && error.code === '23503',
      'provider attempt cannot bind an authorization to another draft'
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO facturations_provider_issuance_attempts
           (business_id,authorization_id,draft_id,provider,operation_key,state,
            started_at,finished_at,provider_invoice_id,provider_invoice_number)
         VALUES ($1,$2,$3,'WAVE',$4,'CONFIRMED',now(),now(),$5,$6)`,
        [
          businessId,
          crossFixture.authorization.id,
          crossFixture.draft.id,
          'wave_' + crypto.randomBytes(32).toString('base64url'),
          'direct-confirmed-' + crypto.randomUUID(),
          'DIRECT-' + crypto.randomUUID().slice(0, 8),
        ]
      ),
      error => error && error.code === '23514',
      'provider attempt cannot be inserted directly as CONFIRMED'
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO facturations_provider_issuance_attempts
           (business_id,authorization_id,draft_id,provider,operation_key,state)
         VALUES ($1,$2,$3,'WAVE',$4,'PREPARED')`,
        [
          businessId,
          crossFixture.authorization.id,
          crossFixture.draft.id,
          'wave_' + crypto.randomBytes(32).toString('base64url'),
        ]
      ),
      error => error && error.code === '23514',
      'direct PREPARED provider attempt without its ledger event must fail at commit'
    );
    const prepared = await attempts.prepare({
      authorizationId: confirmedFixture.authorization.id,
      providerPlanHash: confirmedFixture.payload.providerPlanHash,
    });
    assert.equal(prepared.state, 'PREPARED');
    assert.match(prepared.operationKey, /^wave_[A-Za-z0-9_-]{43}$/);
    assert.equal(prepared.issued, false);
    assert.equal(prepared.waveSynced, false);
    assert.equal(prepared.emailed, false);

    await assert.rejects(
      pool.query(
        `UPDATE facturations_provider_issuance_attempts
            SET state='CONFIRMED',
                started_at=now(),
                finished_at=now(),
                provider_invoice_id=$3,
                provider_invoice_number=$4
          WHERE business_id=$1 AND id=$2`,
        [
          businessId,
          prepared.id,
          'forged-invoice-' + crypto.randomUUID(),
          'FORGED-' + crypto.randomUUID().slice(0, 8),
        ]
      ),
      error => error && error.code === '23514',
      'direct PREPARED to CONFIRMED provider transition must fail'
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_provider_issuance_attempts
            SET state='IN_PROGRESS',started_at=now()
          WHERE business_id=$1 AND id=$2`,
        [businessId, prepared.id]
      ),
      error => error && error.code === '23514',
      'provider state transition without matching ledger event must fail at commit'
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_provider_issuance_attempts
            SET operation_key=$3
          WHERE business_id=$1 AND id=$2`,
        [businessId, prepared.id, 'wave_' + crypto.randomBytes(32).toString('base64url')]
      ),
      error => error && error.code === '23514',
      'provider attempt operation key is immutable'
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO facturations_provider_issuance_events
           (business_id,attempt_id,from_state,to_state,reason_code)
         VALUES ($1,$2,'PREPARED','CONFIRMED','PROVIDER_CONFIRMED')`,
        [businessId, prepared.id]
      ),
      error => error && error.code === '23514',
      'provider event cannot claim a state transition that did not occur'
    );

    const preparedRetry = await attempts.prepare({
      authorizationId: confirmedFixture.authorization.id,
      providerPlanHash: confirmedFixture.payload.providerPlanHash,
    });
    assert.equal(preparedRetry.id, prepared.id);
    assert.equal(preparedRetry.operationKey, prepared.operationKey);

    const ambiguousFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'ambiguous',
    });

    const adapterCalls = [];
    const confirmedExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice(request) {
          assert.notStrictEqual(request.payload, confirmedFixture.payload);
          assert.equal(Object.isFrozen(request.payload), true);
          assert.equal(Object.isFrozen(request.payload.items), true);
          assert.equal(Object.isFrozen(request.payload.items[0]), true);
          assert.equal(Object.isFrozen(request.payload.items[0].salesTaxIds), true);
          adapterCalls.push(request);
          return {
            status: 'CONFIRMED',
            providerInvoiceId: 'wave-invoice-example-confirmed',
            providerInvoiceNumber: 'SYNTHETIC-1001',
          };
        },
      },
    });
    await assert.rejects(
      confirmedExecutor.execute({
        attemptId: prepared.id,
        payload: { ...confirmedFixture.payload, unexpectedOverride: 'forbidden' },
      }),
      error => error instanceof ProviderIssuanceExecutorError &&
        error.code === 'INVALID_PROVIDER_PAYLOAD'
    );
    await assert.rejects(
      confirmedExecutor.execute({
        attemptId: prepared.id,
        payload: {
          ...confirmedFixture.payload,
          items: [
            { ...confirmedFixture.payload.items[0], unexpectedOverride: 'forbidden' },
          ],
        },
      }),
      error => error instanceof ProviderIssuanceExecutorError &&
        error.code === 'INVALID_PROVIDER_PAYLOAD'
    );
    assert.equal(adapterCalls.length, 0, 'unknown provider-plan fields must fail before adapter');

    const remappedPayload = buildWaveIssuancePreflight({
      businessId: 'wave-business-remapped',
      customerId: 'wave-customer-remapped',
      productIds: ['wave-product-remapped'],
      salesTaxes: {},
      snapshot: confirmedFixture.draft.preview,
    });
    assert.equal(remappedPayload.sourceRequestHash, confirmedFixture.payload.sourceRequestHash);
    assert.notEqual(remappedPayload.providerPlanHash, confirmedFixture.payload.providerPlanHash);

    await assert.rejects(
      attempts.prepare({
        authorizationId: confirmedFixture.authorization.id,
        providerPlanHash: remappedPayload.providerPlanHash,
      }),
      error => error instanceof ProviderIssuanceAttemptError &&
        error.code === 'PREPARE_CONFLICT' &&
        error.statusCode === 409
    );

    await assert.rejects(
      confirmedExecutor.execute({
        attemptId: prepared.id,
        payload: remappedPayload,
      }),
      error => error instanceof ProviderIssuanceAttemptError &&
        error.code === 'PROVIDER_PAYLOAD_BINDING_MISMATCH' &&
        error.statusCode === 409
    );
    assert.equal(adapterCalls.length, 0, 'remapped provider plan must not reach adapter');

    await assert.rejects(
      confirmedExecutor.execute({
        attemptId: prepared.id,
        payload: ambiguousFixture.payload,
      }),
      error => error instanceof ProviderIssuanceAttemptError &&
        error.code === 'PROVIDER_PAYLOAD_BINDING_MISMATCH' &&
        error.statusCode === 409
    );
    assert.equal(adapterCalls.length, 0, 'mismatched draft payload must not reach adapter');
    const stillPrepared = await attempts.get({ attemptId: prepared.id });
    assert.equal(stillPrepared.state, 'PREPARED');

    const tamperedPayload = {
      ...confirmedFixture.payload,
      customerId: 'wave-customer-tampered-without-rehash',
    };
    await assert.rejects(
      confirmedExecutor.execute({
        attemptId: prepared.id,
        payload: tamperedPayload,
      }),
      error => error instanceof ProviderIssuanceExecutorError &&
        error.code === 'PROVIDER_PLAN_HASH_MISMATCH' &&
        error.statusCode === 409
    );
    assert.equal(adapterCalls.length, 0, 'tampered plan hash must fail before adapter');

    const confirmed = await confirmedExecutor.execute({
      attemptId: prepared.id,
      payload: confirmedFixture.payload,
    });
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.equal(confirmed.providerInvoiceId, 'wave-invoice-example-confirmed');
    assert.equal(confirmed.providerInvoiceNumber, 'SYNTHETIC-1001');
    assert.equal(confirmed.issued, false, 'provider confirmation does not mutate official local issuance');
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].operationKey, prepared.operationKey);
    assert.equal(adapterCalls[0].payload.status, 'READY_FOR_WAVE_ADAPTER');

    await assert.rejects(confirmedExecutor.execute({
      attemptId: prepared.id,
      payload: confirmedFixture.payload,
    }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'INVALID_ATTEMPT_STATE' &&
      error.statusCode === 409);
    assert.equal(adapterCalls.length, 1, 'confirmed attempt cannot call adapter twice');

    const ambiguousPrepared = await attempts.prepare({
      authorizationId: ambiguousFixture.authorization.id,
      providerPlanHash: ambiguousFixture.payload.providerPlanHash,
    });
    let ambiguousCalls = 0;
    const ambiguousExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          ambiguousCalls++;
          throw new Error('synthetic transport uncertainty');
        },
      },
    });
    const ambiguous = await ambiguousExecutor.execute({
      attemptId: ambiguousPrepared.id,
      payload: ambiguousFixture.payload,
    });
    assert.equal(ambiguous.state, 'AMBIGUOUS');
    assert.equal(ambiguous.outcomeCode, 'ADAPTER_EXCEPTION');
    assert.equal(ambiguous.finishedAt, null);

    await assert.rejects(ambiguousExecutor.execute({
      attemptId: ambiguousPrepared.id,
      payload: ambiguousFixture.payload,
    }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'AMBIGUOUS_REQUIRES_RECONCILIATION' &&
      error.statusCode === 409);
    assert.equal(ambiguousCalls, 1, 'ambiguous state blocks an automatic provider retry');

    await assert.rejects(ambiguousExecutor.reconcile({
      attemptId: ambiguousPrepared.id,
      result: { status: 'AMBIGUOUS', reasonCode: 'STILL_UNKNOWN' },
    }), error =>
      error instanceof ProviderIssuanceExecutorError &&
      error.code === 'RECONCILIATION_INCONCLUSIVE' &&
      error.statusCode === 409);

    const reconciled = await ambiguousExecutor.reconcile({
      attemptId: ambiguousPrepared.id,
      result: {
        status: 'CONFIRMED',
        providerInvoiceId: 'wave-invoice-example-reconciled',
        providerInvoiceNumber: 'SYNTHETIC-1002',
      },
    });
    assert.equal(reconciled.state, 'CONFIRMED');
    assert.equal(reconciled.outcomeCode, 'RECONCILED_CONFIRMED');

    const failedFixture = await authorizedDraft({
      drafts, approvals, authorizations, owner, session, suffix: 'failed',
    });
    const failedPrepared = await attempts.prepare({
      authorizationId: failedFixture.authorization.id,
      providerPlanHash: failedFixture.payload.providerPlanHash,
    });
    const failedExecutor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          return { status: 'FAILED', reasonCode: 'PROVIDER_REJECTED_SYNTHETIC' };
        },
      },
    });
    const failed = await failedExecutor.execute({
      attemptId: failedPrepared.id,
      payload: failedFixture.payload,
    });
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.outcomeCode, 'PROVIDER_REJECTED_SYNTHETIC');

    const foreign = createProviderIssuanceAttemptStore({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(foreign.get({ attemptId: prepared.id }), error =>
      error instanceof ProviderIssuanceAttemptError &&
      error.code === 'ATTEMPT_NOT_FOUND' &&
      error.statusCode === 404);

    const [draftRows, authorizationRows, attemptRows, eventRows, auditRows] = await Promise.all([
      pool.query('SELECT id,status FROM invoice_drafts WHERE business_id=$1 ORDER BY id', [businessId]),
      pool.query(`SELECT id,state FROM facturations_issuance_authorizations
                    WHERE business_id=$1 ORDER BY id`, [businessId]),
      pool.query(`SELECT state,count(*)::integer AS n
                    FROM facturations_provider_issuance_attempts
                   WHERE business_id=$1 GROUP BY state ORDER BY state`, [businessId]),
      pool.query(`SELECT to_state,count(*)::integer AS n
                    FROM facturations_provider_issuance_events
                   WHERE business_id=$1 GROUP BY to_state ORDER BY to_state`, [businessId]),
      pool.query(`SELECT action,count(*)::integer AS n
                    FROM invoice_audit_events
                   WHERE business_id=$1 GROUP BY action ORDER BY action`, [businessId]),
    ]);

    assert.equal(draftRows.rows.length, 4);
    assert.ok(draftRows.rows.every(row => row.status === 'DRAFT'));
    assert.equal(authorizationRows.rows.length, 4);
    assert.ok(authorizationRows.rows.every(row => row.state === 'AUTHORIZED_PENDING_PROVIDER'));
    assert.deepEqual(attemptRows.rows, [
      { state: 'CONFIRMED', n: 2 },
      { state: 'FAILED', n: 1 },
    ]);
    assert.deepEqual(eventRows.rows, [
      { to_state: 'AMBIGUOUS', n: 1 },
      { to_state: 'CONFIRMED', n: 2 },
      { to_state: 'FAILED', n: 1 },
      { to_state: 'IN_PROGRESS', n: 3 },
      { to_state: 'PREPARED', n: 3 },
    ]);
    assert.deepEqual(auditRows.rows, [{ action: 'DRAFT_CREATED', n: 3 }]);
  } finally {
    await pool.end();
  }
});
