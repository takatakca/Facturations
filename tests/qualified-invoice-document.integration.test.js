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
const {
  createInvoiceIssuerBindingStore,
  InvoiceIssuerBindingError,
} = require('../src/invoice-issuer-binding-store');
const {
  createQualifiedInvoiceDocumentStore,
  QualifiedInvoiceDocumentError,
} = require('../src/qualified-invoice-document-store');
const { createClientPortalPublicationStore } = require('../src/client-portal-publication-store');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function provisionOwner({ auth, invitations, password }) {
  const owner = await auth.createPendingStaff({
    email: 'qualified-owner-' + crypto.randomUUID() + '@example.test',
    password,
    role: 'OWNER',
  });
  const invitation = await invitations.issueInvitation({ staffId: owner.id });
  await invitations.redeemInvitation({ token: invitation.token, password });
  const session = await auth.authenticate({ email: owner.email, password });
  return { owner, session };
}

async function createIssuedFixture({
  drafts, approvals, authorizations, attempts, registry, documents,
  owner, session, suffix, taxable,
}) {
  const email = 'qualified-' + suffix + '-' + crypto.randomUUID() + '@example.test';
  const taxes = taxable
    ? [{ code: 'TPS', label: 'TPS', rateMilliPercent: 5000 }]
    : [];
  const draft = await drafts.createDraft({
    currency: 'CAD',
    customer: {
      name: 'Synthetic Customer ' + suffix,
      email,
      address: '123 Example Street',
    },
    invoiceDate: '2026-09-26',
    dueDate: '2026-10-26',
    notes: 'Synthetic qualified PDF test',
    lines: [{
      description: 'Synthetic service ' + suffix,
      quantity: 2,
      unitPriceCents: 1500,
      discountCents: 0,
      taxable,
    }],
    taxes,
  }, 'qualified_' + crypto.randomBytes(16).toString('hex'));

  await approvals.approveDraft({
    confirmation: 'APPROVE_DRAFT_ONLY',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: draft.preview.totalCents,
    expectedCustomerEmail: email,
  });

  const authorization = await authorizations.authorize({
    confirmation: 'AUTHORIZE_ISSUANCE_PENDING_PROVIDER',
    draftId: draft.id,
    ownerId: owner.id,
    sessionToken: session.token,
    expectedTotalCents: draft.preview.totalCents,
    expectedCustomerEmail: email,
    provider: 'WAVE',
  });

  const payload = buildWaveIssuancePreflight({
    businessId: 'wave-business-example',
    customerId: 'wave-customer-' + suffix,
    productIds: ['wave-product-' + suffix],
    salesTaxes: taxable
      ? { TPS: { id: 'wave-tax-' + suffix, rateMilliPercent: 5000 } }
      : {},
    snapshot: draft.preview,
  });

  const prepared = await attempts.prepare({ authorizationId: authorization.id });
  const executor = createProviderIssuanceExecutor({
    attemptStore: attempts,
    adapter: {
      async createInvoice() {
        return {
          status: 'CONFIRMED',
          providerInvoiceId: 'wave-qualified-' + suffix + '-' + crypto.randomUUID(),
          providerInvoiceNumber: 'QUALIFIED-' + suffix.toUpperCase() + '-' + crypto.randomUUID().slice(0, 8),
        };
      },
    },
  });
  const confirmed = await executor.execute({ attemptId: prepared.id, payload });
  const issued = await registry.materialize({ attemptId: confirmed.id });
  const baseDocument = await documents.materialize({ issuedInvoiceId: issued.id });
  return { draft, authorization, confirmed, issued, baseDocument };
}

async function createProfile({ profiles, owner, session, suffix, registrations }) {
  return profiles.createVerified({
    confirmation: 'VERIFY_ISSUER_PROFILE',
    legalName: 'Synthetic Legal Corporation ' + suffix,
    displayName: 'Synthetic Trade ' + suffix,
    addressLines: ['100 Example Avenue', 'Suite ' + suffix],
    city: 'Montreal',
    region: 'QC',
    postalCode: 'H0H 0H0',
    countryCode: 'CA',
    contactEmail: 'issuer-' + suffix + '@example.test',
    contactPhone: '+1 514 555 0100',
    taxRegistrations: registrations,
    verificationMethod: 'HUMAN_DOCUMENT_REVIEW',
    verificationReference: 'synthetic-qualified-review-' + suffix,
    ownerId: owner.id,
    sessionToken: session.token,
  });
}

test('verified issuer binding produces one immutable qualified PDF with full provenance', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'qualified-pdf-' + crypto.randomUUID();
  const password = 'synthetic-qualified-pdf-password-2026!';

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
  const publications = createClientPortalPublicationStore({ pool, businessId });

  try {
    const { owner, session } = await provisionOwner({ auth, invitations, password });

    const fixture = await createIssuedFixture({
      drafts, approvals, authorizations, attempts, registry, documents,
      owner, session, suffix: 'main', taxable: false,
    });
    const profile = await createProfile({
      profiles, owner, session, suffix: 'main',
      registrations: [
        { scheme: 'GST', registrationNumber: 'SYNTHETIC-GST-MAIN' },
        { scheme: 'QST', registrationNumber: 'SYNTHETIC-QST-MAIN' },
      ],
    });

    const bindingInput = {
      confirmation: 'BIND_VERIFIED_ISSUER_TO_INVOICE',
      issuedInvoiceId: fixture.issued.id,
      issuerProfileId: profile.id,
      ownerId: owner.id,
      sessionToken: session.token,
    };
    const binding = await bindings.bind(bindingInput);
    assert.equal(binding.issuedInvoiceId, fixture.issued.id);
    assert.equal(binding.issuerProfileId, profile.id);
    assert.equal(binding.issuerProfileHash, profile.profileHash);
    assert.equal(binding.issuerProfileVersion, profile.version);

    const bindingRetry = await bindings.bind(bindingInput);
    assert.equal(bindingRetry.id, binding.id);

    const qualified = await qualifiedDocuments.materialize({ bindingId: binding.id });
    assert.equal(qualified.bindingId, binding.id);
    assert.equal(qualified.issuedInvoiceId, fixture.issued.id);
    assert.equal(qualified.sourceDocumentId, fixture.baseDocument.id);
    assert.equal(qualified.sourceDocumentSha256, fixture.baseDocument.contentSha256);
    assert.equal(qualified.issuerProfileId, profile.id);
    assert.equal(qualified.issuerProfileHash, profile.profileHash);
    assert.equal(qualified.issuerProfileVersion, profile.version);
    assert.equal(qualified.documentKind, 'QUALIFIED_INVOICE_PDF');
    assert.equal(qualified.deliveryState, 'NOT_AUTHORIZED');
    assert.equal(qualified.deliveryAuthorized, false);
    assert.equal(qualified.emailed, false);
    assert.ok(Buffer.isBuffer(qualified.pdfBytes));
    assert.equal(
      qualified.contentSha256,
      crypto.createHash('sha256').update(qualified.pdfBytes).digest('hex')
    );
    assert.notEqual(
      qualified.contentSha256,
      fixture.baseDocument.contentSha256,
      'issuer-qualified PDF must differ from the base archive'
    );

    const latin = qualified.pdfBytes.toString('latin1');
    assert.ok(latin.includes(profile.legalName));
    assert.ok(latin.includes(profile.profileHash));
    assert.ok(latin.includes('SYNTHETIC-GST-MAIN'));

    const qualifiedRetry = await qualifiedDocuments.materialize({ bindingId: binding.id });
    assert.equal(qualifiedRetry.id, qualified.id);
    assert.deepEqual(qualifiedRetry.pdfBytes, qualified.pdfBytes);

    const publicationInput = {
      confirmation: 'AUTHORIZE_CLIENT_PORTAL_PUBLICATION',
      qualifiedDocumentId: qualified.id,
      ownerId: owner.id,
      sessionToken: session.token,
    };
    const publication = await publications.authorize(publicationInput);
    assert.equal(publication.issuedInvoiceId, fixture.issued.id);
    assert.equal(publication.qualifiedDocumentId, qualified.id);
    assert.equal(publication.qualifiedDocumentSha256, qualified.contentSha256);
    assert.equal(publication.revoked, false);

    const publicationRetry = await publications.authorize(publicationInput);
    assert.equal(publicationRetry.id, publication.id);

    const publicationLookup = await publications.getByQualifiedDocument({
      qualifiedDocumentId: qualified.id,
    });
    assert.equal(publicationLookup.id, publication.id);
    assert.equal(publicationLookup.revoked, false);

    const revoked = await publications.revoke({
      confirmation: 'REVOKE_CLIENT_PORTAL_PUBLICATION',
      publicationId: publication.id,
      reasonCode: 'OWNER_REVOKED',
      ownerId: owner.id,
      sessionToken: session.token,
    });
    assert.equal(revoked.id, publication.id);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.revocationReason, 'OWNER_REVOKED');

    const revokedLookup = await publications.getByQualifiedDocument({
      qualifiedDocumentId: qualified.id,
    });
    assert.equal(revokedLookup.revoked, true);

    await assert.rejects(
      pool.query(
        `UPDATE facturations_client_portal_publications SET confirmation=confirmation
          WHERE business_id=$1 AND id=$2`,
        [businessId, publication.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM facturations_client_portal_publication_revocations
          WHERE business_id=$1 AND publication_id=$2`,
        [businessId, publication.id]
      ),
      error => error && error.code === '23514'
    );

    const newerProfile = await createProfile({
      profiles, owner, session, suffix: 'newer',
      registrations: [{ scheme: 'GST', registrationNumber: 'SYNTHETIC-GST-NEWER' }],
    });
    await assert.rejects(
      bindings.bind({
        ...bindingInput,
        issuerProfileId: newerProfile.id,
      }),
      error => error instanceof InvoiceIssuerBindingError &&
        error.code === 'ISSUER_BINDING_CONFLICT' &&
        error.statusCode === 409
    );

    const taxedFixture = await createIssuedFixture({
      drafts, approvals, authorizations, attempts, registry, documents,
      owner, session, suffix: 'taxed', taxable: true,
    });
    const noTaxEvidenceProfile = await createProfile({
      profiles, owner, session, suffix: 'no-tax-evidence', registrations: [],
    });
    const taxedBinding = await bindings.bind({
      confirmation: 'BIND_VERIFIED_ISSUER_TO_INVOICE',
      issuedInvoiceId: taxedFixture.issued.id,
      issuerProfileId: noTaxEvidenceProfile.id,
      ownerId: owner.id,
      sessionToken: session.token,
    });
    await assert.rejects(
      qualifiedDocuments.materialize({ bindingId: taxedBinding.id }),
      error => error instanceof QualifiedInvoiceDocumentError &&
        error.code === 'TAX_REGISTRATION_EVIDENCE_REQUIRED' &&
        error.statusCode === 409
    );

    const foreign = createQualifiedInvoiceDocumentStore({
      pool,
      businessId: 'qualified-other-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.getByIssuedInvoice({ issuedInvoiceId: fixture.issued.id }),
      error => error instanceof QualifiedInvoiceDocumentError &&
        error.code === 'QUALIFIED_DOCUMENT_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_invoice_issuer_bindings SET confirmation=confirmation
          WHERE business_id=$1 AND id=$2`,
        [businessId, binding.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `UPDATE facturations_qualified_invoice_documents SET delivery_state=delivery_state
          WHERE business_id=$1 AND id=$2`,
        [businessId, qualified.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_qualified_invoice_documents WHERE business_id=$1 AND id=$2',
        [businessId, qualified.id]
      ),
      error => error && error.code === '23514'
    );

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM facturations_invoice_issuer_bindings WHERE business_id=$1) AS bindings,
         (SELECT count(*)::integer FROM facturations_qualified_invoice_documents WHERE business_id=$1) AS qualified_documents`,
      [businessId]
    );
    assert.deepEqual(counts.rows, [{ bindings: 2, qualified_documents: 1 }]);
  } finally {
    await pool.end();
  }
});
