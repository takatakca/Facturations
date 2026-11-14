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
const { createIssuerProfileStore } = require('../src/issuer-profile-store');
const { createIssuedInvoiceDocumentStore } = require('../src/issued-invoice-document-store');
const {
  createDocumentDeliveryAuthorizationStore,
  DocumentDeliveryAuthorizationError,
} = require('../src/document-delivery-authorization-store');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function ownerFixture({ auth, invitations, password }) {
  const owner = await auth.createPendingStaff({
    email: 'delivery-owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invitations.issueInvitation({ staffId: owner.id });
  await invitations.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

test('owner authorizes exact immutable PDF for email without sending it', {
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
  const issueAuth = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });
  const registry = createIssuedInvoiceRegistry({ pool, businessId });
  const profiles = createIssuerProfileStore({ pool, businessId });
  const documents = createIssuedInvoiceDocumentStore({ pool, businessId });
  const delivery = createDocumentDeliveryAuthorizationStore({ pool, businessId });

  try {
    const { owner, session } = await ownerFixture({ auth, invitations, password });
    const customerEmail = 'recipient-' + crypto.randomUUID() + '@example.test';

    const draft = await drafts.createDraft({
      currency: 'CAD',
      customer: {
        name: 'Client Livraison Épreuve',
        email: customerEmail,
        address: '100 rue Exemple, Montréal, Québec',
      },
      invoiceDate: '2026-09-25',
      dueDate: '2026-10-25',
      notes: 'Aucun envoi réel.',
      lines: [{
        description: 'Service synthétique',
        quantity: 1,
        unitPriceCents: 4200,
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
      expectedTotalCents: 4200,
      expectedCustomerEmail: customerEmail,
    });

    const authorization = await issueAuth.authorize({
      confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
      draftId: draft.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedTotalCents: 4200,
      expectedCustomerEmail: customerEmail,
      provider: 'WAVE',
    });

    const payload = buildWaveIssuancePreflight({
      businessId: 'wave-business-delivery-example',
      customerId: 'wave-customer-delivery-example',
      productIds: ['wave-product-delivery-example'],
      salesTaxes: {},
      snapshot: draft.preview,
    });

    const prepared = await attempts.prepare({ authorizationId: authorization.id });
    const executor = createProviderIssuanceExecutor({
      attemptStore: attempts,
      adapter: {
        async createInvoice() {
          return {
            status: 'CONFIRMED',
            providerInvoiceId: 'wave-delivery-' + crypto.randomUUID(),
            providerInvoiceNumber: 'SYNTHETIC-DELIVERY-' + crypto.randomUUID().slice(0, 8),
          };
        },
      },
    });
    const confirmed = await executor.execute({ attemptId: prepared.id, payload });
    const issued = await registry.materialize({ attemptId: confirmed.id });

    const profile = await profiles.createVersion({
      confirmation: 'CREATE_ISSUER_PROFILE_VERSION',
      ownerId: owner.id,
      sessionToken: session.token,
      legalName: 'Example Legal Québec Inc.',
      tradeName: 'GROUPE TAKATAK',
      addressLine1: '200 rue Émetteur',
      addressLine2: null,
      city: 'Montréal',
      region: 'Québec',
      postalCode: 'H0H 0H0',
      countryCode: 'CA',
      email: 'issuer@example.test',
      phone: '+1 514 555 0100',
      businessRegistrationNumber: 'SYNTHETIC-REG-DELIVERY',
      taxIdentifiers: {
        GST: 'SYNTHETIC-GST-DELIVERY',
        QST: 'SYNTHETIC-QST-DELIVERY',
      },
    });
    const verifiedProfile = await profiles.verify({
      confirmation: 'VERIFY_ISSUER_PROFILE_FOR_INVOICING',
      ownerId: owner.id,
      sessionToken: session.token,
      profileVersionId: profile.id,
    });

    const document = await documents.materialize({
      issuedInvoiceId: issued.id,
      issuerProfileVersionId: verifiedProfile.id,
    });

    const request = {
      confirmation: 'AUTHORIZE_EMAIL_DELIVERY',
      channel: 'EMAIL',
      documentId: document.id,
      ownerId: owner.id,
      sessionToken: session.token,
      expectedRecipientEmail: customerEmail,
      expectedOfficialInvoiceNumber: issued.officialInvoiceNumber,
      expectedContentSha256: document.contentSha256,
      expectedIssuerProfileHash: verifiedProfile.profileHash,
    };

    await assert.rejects(
      delivery.authorize({ ...request, expectedRecipientEmail: 'wrong@example.test' }),
      error => error instanceof DocumentDeliveryAuthorizationError &&
        error.code === 'DELIVERY_CONFIRMATION_MISMATCH' &&
        error.statusCode === 409
    );

    await assert.rejects(
      delivery.authorize({ ...request, expectedContentSha256: '0'.repeat(64) }),
      error => error instanceof DocumentDeliveryAuthorizationError &&
        error.code === 'DELIVERY_CONFIRMATION_MISMATCH' &&
        error.statusCode === 409
    );

    await assert.rejects(
      delivery.authorize({ ...request, expectedIssuerProfileHash: '1'.repeat(64) }),
      error => error instanceof DocumentDeliveryAuthorizationError &&
        error.code === 'DELIVERY_CONFIRMATION_MISMATCH' &&
        error.statusCode === 409
    );

    const authorized = await delivery.authorize(request);
    assert.equal(authorized.documentId, document.id);
    assert.equal(authorized.issuedInvoiceId, issued.id);
    assert.equal(authorized.channel, 'EMAIL');
    assert.equal(authorized.recipientEmail, customerEmail);
    assert.equal(authorized.officialInvoiceNumber, issued.officialInvoiceNumber);
    assert.equal(authorized.documentSha256, document.contentSha256);
    assert.equal(authorized.issuerProfileVersionId, verifiedProfile.id);
    assert.equal(authorized.issuerProfileHash, verifiedProfile.profileHash);
    assert.equal(authorized.state, 'AUTHORIZED_NOT_SENT');
    assert.equal(authorized.deliveryAuthorized, true);
    assert.equal(authorized.sent, false);
    assert.equal(authorized.emailed, false);

    const repeated = await delivery.authorize(request);
    assert.equal(repeated.id, authorized.id);
    assert.equal(repeated.authorizedAt, authorized.authorizedAt);

    const loaded = await delivery.getByDocument({ documentId: document.id });
    assert.equal(loaded.id, authorized.id);

    const foreign = createDocumentDeliveryAuthorizationStore({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.getByDocument({ documentId: document.id }),
      error => error instanceof DocumentDeliveryAuthorizationError &&
        error.code === 'DELIVERY_AUTHORIZATION_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_document_delivery_authorizations
            SET state='AUTHORIZED_NOT_SENT'
          WHERE business_id=$1 AND id=$2`,
        [businessId, authorized.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_document_delivery_authorizations WHERE business_id=$1 AND id=$2',
        [businessId, authorized.id]
      ),
      error => error && error.code === '23514'
    );

    const [invoiceRows, documentRows, authorizationRows] = await Promise.all([
      pool.query(
        'SELECT status,delivery_state FROM facturations_issued_invoices WHERE business_id=$1 AND id=$2',
        [businessId, issued.id]
      ),
      pool.query(
        'SELECT delivery_state FROM facturations_issued_invoice_documents WHERE business_id=$1 AND id=$2',
        [businessId, document.id]
      ),
      pool.query(
        'SELECT state,count(*)::integer AS n FROM facturations_document_delivery_authorizations WHERE business_id=$1 GROUP BY state',
        [businessId]
      ),
    ]);
    assert.deepEqual(invoiceRows.rows, [{
      status: 'ISSUED_CONFIRMED',
      delivery_state: 'NOT_AUTHORIZED',
    }]);
    assert.deepEqual(documentRows.rows, [{ delivery_state: 'NOT_AUTHORIZED' }]);
    assert.deepEqual(authorizationRows.rows, [{ state: 'AUTHORIZED_NOT_SENT', n: 1 }]);
  } finally {
    await pool.end();
  }
});
