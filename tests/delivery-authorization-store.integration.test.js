'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createStaffAuthStore } = require('../src/staff-auth-store');
const { createStaffInvitationStore } = require('../src/staff-invitation-store');
const { createDraftStore } = require('../src/draft-store');
const { createDraftApprovalStore } = require('../src/draft-approval-store');
const { createIssuanceAuthorizationStore } = require('../src/issuance-authorization-store');
const { createProviderIssuanceAttemptStore } = require('../src/provider-issuance-attempt-store');
const { createProviderIssuanceExecutor } = require('../src/provider-issuance-executor');
const { createIssuedInvoiceRegistry } = require('../src/issued-invoice-registry');
const { createIssuedInvoiceDocumentStore } = require('../src/issued-invoice-document-store');
const { createIssuerProfileStore } = require('../src/issuer-profile-store');
const { createInvoiceIssuerBindingStore } = require('../src/invoice-issuer-binding-store');
const { createQualifiedInvoiceDocumentStore } = require('../src/qualified-invoice-document-store');
const {
  createDeliveryAuthorizationStore,
  DeliveryAuthorizationError,
} = require('../src/delivery-authorization-store');
const { createDeliveryAttemptStore } = require('../src/delivery-attempt-store');
const { createDeliveryExecutor } = require('../src/delivery-executor');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

test('delivery authorization binds OWNER consent to exact qualified PDF and exact recipient', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'delivery-auth-' + crypto.randomUUID();
  const password = 'synthetic-delivery-auth-password-2026!';

  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });
  const registry = createIssuedInvoiceRegistry({ pool, businessId });
  const documents = createIssuedInvoiceDocumentStore({ pool, businessId });
  const profiles = createIssuerProfileStore({ pool, businessId });
  const bindings = createInvoiceIssuerBindingStore({ pool, businessId });
  const qualifiedDocuments = createQualifiedInvoiceDocumentStore({ pool, businessId });
  const delivery = createDeliveryAuthorizationStore({ pool, businessId });
  const deliveryAttempts = createDeliveryAttemptStore({ pool, businessId });

  try {
    const owner = await auth.createPendingStaff({
      email: 'owner-' + crypto.randomUUID() + '@example.test',
      password,
      role: 'OWNER',
    });
    const invitation = await invitations.issueInvitation({ staffId: owner.id });
    await invitations.redeemInvitation({ token: invitation.token, password });
    const session = await auth.authenticate({ email: owner.email, password });

    const recipient = 'recipient-' + crypto.randomUUID() + '@example.test';
    const draft = await drafts.createDraft({
      currency: 'CAD',
      customer: {
        name: 'Synthetic Delivery Customer',
        email: recipient,
        address: '123 Example Street',
      },
      invoiceDate: '2026-09-26',
      dueDate: '2026-10-26',
      notes: 'Synthetic delivery authorization test',
      lines: [{
        description: 'Synthetic service',
        quantity: 1,
        unitPriceCents: 2500,
        discountCents: 0,
        taxable: false,
      }],
      taxes: [],
    }, 'delivery_' + crypto.randomBytes(16).toString('hex'));

    await approvals.approveDraft({
      confirmation: 'APPROVE_DRAFT_ONLY',
      draftId: draft.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedTotalCents: 2500,
      expectedCustomerEmail: recipient,
    });

    const issuanceAuthorization = await authorizations.authorize({
      confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      draftId: draft.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedTotalCents: 2500,
      expectedCustomerEmail: recipient,
      provider: 'WAVE',
    });

    const payload = buildWaveIssuancePreflight({
      businessId: 'wave-business-example',
      customerId: 'wave-customer-delivery',
      productIds: ['wave-product-delivery'],
      salesTaxes: {},
      snapshot: draft.preview,
    });

    const prepared = await attempts.prepare({ authorizationId: issuanceAuthorization.id });
    const executor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          return {
            status: 'CONFIRMED',
            providerInvoiceId: 'wave-delivery-' + crypto.randomUUID(),
            providerInvoiceNumber: 'DELIVERY-' + crypto.randomUUID().slice(0, 8),
          };
        },
      },
    });
    const confirmed = await executor.execute({ attemptId: prepared.id, payload });
    const issued = await registry.materialize({ attemptId: confirmed.id });
    await documents.materialize({ issuedInvoiceId: issued.id });

    const profile = await profiles.createVerified({
      confirmation: 'VERIFY_ISSUER_PROFILE',
      legalName: 'Synthetic Legal Corporation',
      displayName: 'Synthetic Trade Name',
      addressLines: ['100 Example Avenue'],
      city: 'Montreal',
      region: 'QC',
      postalCode: 'H0H 0H0',
      countryCode: 'CA',
      contactEmail: 'billing@example.test',
      contactPhone: null,
      taxRegistrations: [],
      verificationMethod: 'HUMAN_DOCUMENT_REVIEW',
      verificationReference: 'synthetic-delivery-review',
      ownerId: owner.id,
      sessionToken: session.token,
    });

    const binding = await bindings.bind({
      confirmation: 'BIND_VERIFIED_ISSUER_TO_INVOICE',
      issuedInvoiceId: issued.id,
      issuerProfileId: profile.id,
      ownerId: owner.id,
      sessionToken: session.token,
    });
    const qualified = await qualifiedDocuments.materialize({ bindingId: binding.id });

    await assert.rejects(
      delivery.authorize({
        confirmation: 'AUTHORIZE_QUALIFIED_PDF_DELIVERY',
        qualifiedDocumentId: qualified.id,
        expectedRecipientEmail: 'wrong-recipient@example.test',
        ownerId: owner.id,
        sessionToken: session.token,
      }),
      error => error instanceof DeliveryAuthorizationError &&
        error.code === 'RECIPIENT_MISMATCH' &&
        error.statusCode === 409
    );

    const input = {
      confirmation: 'AUTHORIZE_QUALIFIED_PDF_DELIVERY',
      qualifiedDocumentId: qualified.id,
      expectedRecipientEmail: recipient.toUpperCase(),
      ownerId: owner.id,
      sessionToken: session.token,
    };
    const authorized = await delivery.authorize(input);
    assert.equal(authorized.issuedInvoiceId, issued.id);
    assert.equal(authorized.qualifiedDocumentId, qualified.id);
    assert.equal(authorized.qualifiedDocumentSha256, qualified.contentSha256);
    assert.equal(authorized.expectedRecipientEmail, recipient.toLowerCase());
    assert.match(authorized.recipientSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(authorized.authorizedBy, owner.id);
    assert.equal(authorized.state, 'AUTHORIZED_PENDING_DELIVERY');
    assert.equal(authorized.deliveryPerformed, false);
    assert.equal(authorized.emailed, false);

    const retry = await delivery.authorize(input);
    assert.equal(retry.id, authorized.id);
    assert.equal(retry.recipientSnapshotHash, authorized.recipientSnapshotHash);

    const found = await delivery.getByQualifiedDocument({ qualifiedDocumentId: qualified.id });
    assert.equal(found.id, authorized.id);

    const deliveryAttempt = await deliveryAttempts.prepare({ authorizationId: authorized.id });
    assert.equal(deliveryAttempt.state, 'PREPARED');
    assert.equal(deliveryAttempt.provider, 'SIMULATED_EMAIL');
    assert.equal(deliveryAttempt.emailed, false);

    const deliveryExecutor = createDeliveryExecutor({
      attemptStore: deliveryAttempts,
      adapter: {
        async sendDocument(request) {
          assert.equal(request.operationKey, deliveryAttempt.operationKey);
          assert.equal(request.provider, 'SIMULATED_EMAIL');
          assert.equal(request.authorizationId, authorized.id);
          assert.equal(request.qualifiedDocumentId, qualified.id);
          return {
            status: 'CONFIRMED',
            providerMessageId: 'simulated-message-' + crypto.randomUUID(),
          };
        },
      },
    });
    const delivered = await deliveryExecutor.execute({ attemptId: deliveryAttempt.id });
    assert.equal(delivered.state, 'CONFIRMED');
    assert.ok(delivered.providerMessageId.startsWith('simulated-message-'));
    assert.equal(delivered.emailed, true);

    const eventRows = await pool.query(
      `SELECT from_state,to_state,reason_code
         FROM facturations_delivery_events
        WHERE business_id=$1 AND attempt_id=$2
        ORDER BY id`,
      [businessId, deliveryAttempt.id]
    );
    assert.deepEqual(eventRows.rows, [
      { from_state: null, to_state: 'PREPARED', reason_code: 'OWNER_DELIVERY_AUTHORIZATION_READY' },
      { from_state: 'PREPARED', to_state: 'IN_PROGRESS', reason_code: 'ADAPTER_STARTED' },
      { from_state: 'IN_PROGRESS', to_state: 'CONFIRMED', reason_code: 'PROVIDER_CONFIRMED' },
    ]);

    const foreign = createDeliveryAuthorizationStore({
      pool,
      businessId: 'delivery-other-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.getByQualifiedDocument({ qualifiedDocumentId: qualified.id }),
      error => error instanceof DeliveryAuthorizationError &&
        error.code === 'DELIVERY_AUTHORIZATION_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_delivery_authorizations SET state=state
          WHERE business_id=$1 AND id=$2`,
        [businessId, authorized.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_delivery_authorizations WHERE business_id=$1 AND id=$2',
        [businessId, authorized.id]
      ),
      error => error && error.code === '23514'
    );

    const sourceStates = await pool.query(
      `SELECT
        (SELECT delivery_state FROM facturations_issued_invoices
          WHERE business_id=$1 AND id=$2) AS invoice_delivery_state,
        (SELECT delivery_state FROM facturations_qualified_invoice_documents
          WHERE business_id=$1 AND id=$3) AS document_delivery_state`,
      [businessId, issued.id, qualified.id]
    );
    assert.deepEqual(sourceStates.rows, [{
      invoice_delivery_state: 'NOT_AUTHORIZED',
      document_delivery_state: 'NOT_AUTHORIZED',
    }]);

    await assert.rejects(
      pool.query(
        `UPDATE facturations_delivery_events SET reason_code=reason_code
          WHERE business_id=$1 AND attempt_id=$2`,
        [businessId, deliveryAttempt.id]
      ),
      error => error && error.code === '23514'
    );
  } finally {
    await pool.end();
  }
});
