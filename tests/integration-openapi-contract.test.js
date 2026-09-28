'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spec = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'takatak-integration-v1.openapi.json'),
  'utf8',
));

test('integration OpenAPI contract is versioned, server-to-server and exposes only staged routes', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'GROUPE TAKATAK Facturations Integration API');
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');

  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/integration/v1/approvals',
    '/integration/v1/capabilities',
    '/integration/v1/customers',
    '/integration/v1/dashboard',
    '/integration/v1/drafts',
    '/integration/v1/drafts/{draftId}',
    '/integration/v1/drafts/{draftId}/approval',
    '/integration/v1/drafts/{draftId}/workflow',
    '/integration/v1/handoffs/owner-review',
  ]);

  assert.ok(spec.paths['/integration/v1/drafts'].get);
  assert.ok(spec.paths['/integration/v1/drafts'].post);
  assert.equal(spec.paths['/integration/v1/drafts/{draftId}'].post, undefined);
  assert.equal(spec.paths['/integration/v1/approvals'].post, undefined);
});

test('OpenAPI write contract stays DRAFT-only and requires idempotency', () => {
  const create = spec.paths['/integration/v1/drafts'].post;
  assert.match(create.description, /does not issue, send, publish, pay or write an invoice to Wave/i);
  assert.ok(create.parameters.some(item =>
    item.$ref === '#/components/parameters/IdempotencyKey'
  ));
  assert.equal(
    spec.components.parameters.IdempotencyKey.schema.pattern,
    '^[A-Za-z0-9_-]{16,80}$',
  );
  assert.ok(create.responses['400']);
  assert.ok(create.responses['413']);
  assert.match(create.responses['401'].description, /replayed write bearer|INTEGRATION_TOKEN_REPLAY/i);
  assert.match(create.responses['503'].description, /replay guard/i);

  const draftInput = spec.components.schemas.DraftInput;
  const customerInput = spec.components.schemas.CustomerInput;
  const lineInput = spec.components.schemas.LineInput;
  assert.equal(draftInput.required.includes('notes'), false);
  assert.equal(customerInput.required.includes('address'), false);
  assert.equal(lineInput.required.includes('discountCents'), false);
  assert.equal(lineInput.properties.unitPriceCents.maximum, 100000000);
  assert.match(lineInput.properties.discountCents.description, /quantity \* unitPriceCents/);

  const capability = spec.components.schemas.CapabilitiesEnvelope.allOf[1]
    .properties.data.properties.capabilities.properties;
  assert.equal(capability.ownerApprovalWrite.const, false);
  assert.equal(capability.issuanceAuthorizationWrite.const, false);
  assert.equal(capability.deliveryAuthorizationWrite.const, false);
  assert.equal(capability.portalPublicationWrite.const, false);
  assert.equal(capability.ownerReviewHandoffRead.type, 'boolean');

  const handoff = spec.paths['/integration/v1/handoffs/owner-review'].get;
  assert.equal(
    handoff.responses['200'].content['application/json'].schema
      .allOf[1].properties.data.properties.financialAuthorization.const,
    false,
  );
});

test('OpenAPI read models preserve draft-only and internal-approval semantics', () => {
  const dashboard = spec.components.schemas.DashboardEnvelope.allOf[1]
    .properties.data.properties;
  assert.equal(dashboard.status.const, 'DRAFTS_ONLY');
  assert.equal(dashboard.issuedInvoicesAvailable.const, false);
  assert.equal(dashboard.paymentsAvailable.const, false);
  assert.equal(dashboard.revenueAvailable.const, false);

  const approval = spec.components.schemas.ApprovalSummary.properties;
  assert.equal(approval.status.const, 'APPROVED_INTERNAL_ONLY');
  assert.equal(approval.issued.const, false);
  assert.equal(approval.waveSynced.const, false);
  assert.equal(approval.emailed.const, false);
  assert.equal(approval.paid.const, false);
  assert.equal(approval.approvedBy, undefined);

  const workflow = spec.paths['/integration/v1/drafts/{draftId}/workflow']
    .get.responses['200'].content['application/json'].schema
    .properties.data.properties;
  assert.equal(workflow.status.const, 'DRAFT');
  assert.deepEqual(workflow.internalApproval.enum.sort(),
    ['APPROVED_INTERNAL_ONLY', 'NOT_APPROVED'].sort());
  assert.equal(workflow.nativeActions.properties.approve.const, false);
  assert.equal(workflow.nativeActions.properties.authorizeIssuance.const, false);
  assert.equal(workflow.nativeActions.properties.issue.const, false);
  assert.equal(workflow.nativeActions.properties.deliver.const, false);
  assert.equal(workflow.nativeActions.properties.recordPayment.const, false);
});

test('OpenAPI pagination and search constraints match runtime bounds', () => {
  assert.equal(spec.components.parameters.Page.schema.maximum, 1000);
  assert.equal(spec.components.parameters.PageSize.schema.maximum, 50);

  const q = spec.paths['/integration/v1/customers'].get.parameters
    .find(item => item.name === 'q').schema;
  assert.equal(q.minLength, 2);
  assert.equal(q.maxLength, 80);
  assert.ok(q.pattern);

  for (const pathName of [
    '/integration/v1/drafts',
    '/integration/v1/customers',
    '/integration/v1/approvals',
  ]) {
    assert.ok(spec.paths[pathName].get.responses['404']);
  }
});

test('OpenAPI contract never embeds real origins, secrets or provider credentials', () => {
  const serialized = JSON.stringify(spec);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|FACTURATIONS_DATABASE_URL|TAKATAK_ADMIN_KEY|WAVE_ACCESS_TOKEN/i);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(serialized, /customer@(?!example\.test)/i);
  assert.match(serialized, /facturations\.example\.invalid/);
});
