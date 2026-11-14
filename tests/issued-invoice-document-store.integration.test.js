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
const {
  createIssuedInvoiceDocumentStore,
  IssuedInvoiceDocumentError,
} = require('../src/issued-invoice-document-store');
const { buildWaveIssuancePreflight } = require('../src/wave-issuance-preflight');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;

async function ownerFixture({ auth, invitations, password }) {
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

test('issued invoice PDF is stored immutably, hashed and never authorizes delivery', {
  skip: !DATABASE,
}, async () => {
  const url = new URL(DATABASE);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.pathname, '/facturations_test');
  assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined);
  assert.equal(process.env.WAVE_ACCESS_TOKEN, undefined);

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE });
  const businessId = 'pdf-archive-' + crypto.randomUUID();
  const password = 'synthetic-pdf-archive-password-2026!';
  const auth = createStaffAuthStore({ pool, businessId });
  const invitations = createStaffInvitationStore({ pool, businessId });
  const drafts = createDraftStore({ pool, businessId });
  const approvals = createDraftApprovalStore({ pool, businessId });
  const authorizations = createIssuanceAuthorizationStore({ pool, businessId });
  const attempts = createProviderIssuanceAttemptStore({ pool, businessId });
  const registry = createIssuedInvoiceRegistry({ pool, businessId });
  const profiles = createIssuerProfileStore({ pool, businessId });
  const documents = createIssuedInvoiceDocumentStore({ pool, businessId });

  try {
    const { owner, session } = await ownerFixture({ auth, invitations, password });
    const email = 'client-' + crypto.randomUUID() + '@example.test';
    const draft = await drafts.createDraft({
      currency: 'CAD',
      customer: {
        name: 'Élodie Montréal',
        email,
        address: '123, rue Québec, Montréal',
      },
      invoiceDate: '2026-09-25',
      dueDate: '2026-10-25',
      notes: 'Merci — document synthétique.',
      lines: [{
        description: 'Service de consultation',
        quantity: 2,
        unitPriceCents: 1500,
        discountCents: 0,
        taxable: false,
      }],
      taxes: [],
    }, 'pdf_' + crypto.randomBytes(16).toString('hex'));

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
      customerId: 'wave-customer-pdf-example',
      productIds: ['wave-product-pdf-example'],
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
            providerInvoiceId: 'wave-pdf-' + crypto.randomUUID(),
            providerInvoiceNumber: 'SYNTHETIC-PDF-' + crypto.randomUUID().slice(0, 8),
          };
        },
      },
    });
    const confirmed = await executor.execute({ attemptId: prepared.id, payload });
    const issued = await registry.materialize({ attemptId: confirmed.id });

    const issuerProfile = await profiles.createVersion({
      confirmation: 'CREATE_ISSUER_PROFILE_VERSION',
      ownerId: owner.id,
      sessionToken: session.token,
      legalName: 'Example Legal Québec Inc.',
      tradeName: 'GROUPE TAKATAK',
      addressLine1: '100 rue Exemple',
      addressLine2: null,
      city: 'Montréal',
      region: 'Québec',
      postalCode: 'H0H 0H0',
      countryCode: 'CA',
      email: 'billing@example.test',
      phone: '+1 514 555 0100',
      businessRegistrationNumber: 'SYNTHETIC-REG-PDF',
      taxIdentifiers: {
        GST: 'SYNTHETIC-GST-PDF',
        QST: 'SYNTHETIC-QST-PDF',
      },
    });

    await assert.rejects(
      documents.materialize({
        issuedInvoiceId: issued.id,
        issuerProfileVersionId: issuerProfile.id,
      }),
      error => error instanceof IssuedInvoiceDocumentError &&
        error.code === 'VERIFIED_ISSUER_PROFILE_REQUIRED' &&
        error.statusCode === 409
    );

    const verifiedIssuer = await profiles.verify({
      confirmation: 'VERIFY_ISSUER_PROFILE_FOR_INVOICING',
      ownerId: owner.id,
      sessionToken: session.token,
      profileVersionId: issuerProfile.id,
    });

    const document = await documents.materialize({
      issuedInvoiceId: issued.id,
      issuerProfileVersionId: verifiedIssuer.id,
    });
    assert.equal(document.issuedInvoiceId, issued.id);
    assert.equal(document.issuerProfileVersionId, verifiedIssuer.id);
    assert.equal(document.issuerProfileHash, verifiedIssuer.profileHash);
    assert.equal(document.issuerProfileSnapshot.legalName, verifiedIssuer.legalName);
    assert.equal(document.documentKind, 'INVOICE_PDF');
    assert.equal(document.contentType, 'application/pdf');
    assert.equal(document.deliveryState, 'NOT_AUTHORIZED');
    assert.equal(document.deliveryAuthorized, false);
    assert.equal(document.emailed, false);
    assert.ok(Buffer.isBuffer(document.pdfBytes));
    assert.equal(document.byteLength, document.pdfBytes.length);
    assert.equal(document.pdfBytes.subarray(0, 8).toString('ascii'), '%PDF-1.4');
    assert.ok(document.pdfBytes.subarray(-32).toString('ascii').includes('%%EOF'));
    assert.equal(
      document.contentSha256,
      crypto.createHash('sha256').update(document.pdfBytes).digest('hex')
    );

    const repeated = await documents.materialize({
      issuedInvoiceId: issued.id,
      issuerProfileVersionId: verifiedIssuer.id,
    });
    assert.equal(repeated.id, document.id);
    assert.equal(repeated.contentSha256, document.contentSha256);
    assert.deepEqual(repeated.pdfBytes, document.pdfBytes);

    const loaded = await documents.getByIssuedInvoice({ issuedInvoiceId: issued.id });
    assert.equal(loaded.id, document.id);
    assert.deepEqual(loaded.pdfBytes, document.pdfBytes);

    const conflictingRenderer = createIssuedInvoiceDocumentStore({
      pool,
      businessId,
      renderer: async () => Buffer.concat([
        Buffer.from('%PDF-1.4\n', 'ascii'),
        Buffer.alloc(160, 65),
        Buffer.from('\n%%EOF\n', 'ascii'),
      ]),
    });
    await assert.rejects(
      conflictingRenderer.materialize({
        issuedInvoiceId: issued.id,
        issuerProfileVersionId: verifiedIssuer.id,
      }),
      error => error instanceof IssuedInvoiceDocumentError &&
        error.code === 'DOCUMENT_CONFLICT' &&
        error.statusCode === 409
    );

    const foreign = createIssuedInvoiceDocumentStore({
      pool,
      businessId: 'other-business-' + crypto.randomUUID(),
    });
    await assert.rejects(
      foreign.materialize({
        issuedInvoiceId: issued.id,
        issuerProfileVersionId: verifiedIssuer.id,
      }),
      error => error instanceof IssuedInvoiceDocumentError &&
        error.code === 'ISSUED_INVOICE_NOT_FOUND' &&
        error.statusCode === 404
    );

    await assert.rejects(
      pool.query(
        `UPDATE facturations_issued_invoice_documents SET delivery_state='NOT_AUTHORIZED'
          WHERE business_id=$1 AND id=$2`,
        [businessId, document.id]
      ),
      error => error && error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issued_invoice_documents WHERE business_id=$1 AND id=$2',
        [businessId, document.id]
      ),
      error => error && error.code === '23514'
    );

    const binding = await pool.query(
      `SELECT id,issuer_profile_version_id,issuer_profile_hash
         FROM facturations_issued_invoice_document_issuer_bindings
        WHERE business_id=$1 AND document_id=$2`,
      [businessId, document.id]
    );
    assert.equal(binding.rows[0].issuer_profile_version_id, verifiedIssuer.id);
    assert.equal(binding.rows[0].issuer_profile_hash, verifiedIssuer.profileHash);
    await assert.rejects(
      pool.query(
        'DELETE FROM facturations_issued_invoice_document_issuer_bindings WHERE business_id=$1 AND id=$2',
        [businessId, binding.rows[0].id]
      ),
      error => error && error.code === '23514'
    );

    const [draftRows, issuedRows, documentRows] = await Promise.all([
      pool.query('SELECT status FROM invoice_drafts WHERE business_id=$1 AND id=$2', [businessId, draft.id]),
      pool.query(
        'SELECT status,delivery_state FROM facturations_issued_invoices WHERE business_id=$1 AND id=$2',
        [businessId, issued.id]
      ),
      pool.query(
        'SELECT delivery_state,count(*)::integer AS n FROM facturations_issued_invoice_documents WHERE business_id=$1 GROUP BY delivery_state',
        [businessId]
      ),
    ]);
    assert.deepEqual(draftRows.rows, [{ status: 'DRAFT' }]);
    assert.deepEqual(issuedRows.rows, [{ status: 'ISSUED_CONFIRMED', delivery_state: 'NOT_AUTHORIZED' }]);
    assert.deepEqual(documentRows.rows, [{ delivery_state: 'NOT_AUTHORIZED', n: 1 }]);
  } finally {
    await pool.end();
  }
});
