'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWaveInvoiceCreateMutation,
  buildWaveInvoiceApproveMutation,
} = require('../src/wave-mutation-contract-v2');
const {
  WAVE_GRAPHQL_URL,
  WaveMutationNetworkError,
  createWaveNetworkAdapter,
} = require('../src/wave-network-adapter');

function plan() {
  return {
    status: 'READY_FOR_WAVE_ADAPTER',
    operation: 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY',
    businessId: 'wave-business-authorized-test',
    customerId: 'wave-customer-synthetic',
    currency: 'CAD',
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    memo: 'Synthetic network adapter test only',
    items: [{
      productId: 'wave-product-synthetic',
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1250,
      taxable: false,
      salesTaxIds: [],
    }],
    expected: {
      customerEmail: 'customer@example.test',
      subtotalCents: 2500,
      taxTotalCents: 0,
      totalCents: 2500,
    },
    externalActionsPerformed: {
      createInvoice: false,
      approveInvoice: false,
      sendInvoice: false,
    },
  };
}

function adapter(fetchImpl, overrides = {}) {
  return createWaveNetworkAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: 'synthetic-token-never-sent-to-wave-123456',
    allowedBusinessId: 'wave-business-authorized-test',
    grantedScopes: ['invoice:write'],
    fetchImpl,
    ...overrides,
  });
}

function expectNetwork(code, { unknown, statusCode } = {}) {
  return error => error instanceof WaveMutationNetworkError &&
    error.code === code &&
    (unknown === undefined || error.outcomeUnknown === unknown) &&
    (statusCode === undefined || error.statusCode === statusCode);
}

test('network adapter is disabled by default and never invokes fetch', async () => {
  let calls = 0;
  const guarded = createWaveNetworkAdapter({
    fetchImpl: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(guarded.mode, 'DISABLED');
  assert.equal(guarded.endpoint, WAVE_GRAPHQL_URL);
  await assert.rejects(guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: buildWaveInvoiceCreateMutation(plan()),
  }), expectNetwork('WAVE_NETWORK_DISABLED', { unknown: false, statusCode: 503 }));
  assert.equal(calls, 0);
});

test('authorized test mode requires bounded token, invoice write scope and business binding', () => {
  assert.throws(() => createWaveNetworkAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: 'synthetic-token-never-sent-to-wave-123456',
    allowedBusinessId: 'wave-business-authorized-test',
    grantedScopes: ['invoice:read'],
    fetchImpl: async () => {},
  }), /invoice:write/);

  assert.throws(() => createWaveNetworkAdapter({
    activation: 'AUTHORIZED_TEST_ONLY',
    token: 'short',
    allowedBusinessId: 'wave-business-authorized-test',
    grantedScopes: ['invoice:write'],
    fetchImpl: async () => {},
  }), /access token/);

  assert.throws(() => createWaveNetworkAdapter({
    activation: 'LIVE_PRODUCTION',
  }), /DISABLED or AUTHORIZED_TEST_ONLY/);
});

test('authorized test mode sends only the fixed create contract to the fixed Wave endpoint', async () => {
  const create = buildWaveInvoiceCreateMutation(plan());
  let seen;
  const guarded = adapter(async (url, options) => {
    seen = { url, options };
    return new Response(JSON.stringify({
      data: {
        invoiceCreate: {
          didSucceed: true,
          inputErrors: [],
          invoice: {
            id: 'synthetic-provider-invoice',
            invoiceNumber: 'SYNTHETIC-1001',
            status: 'DRAFT',
            customer: { id: 'wave-customer-synthetic' },
            currency: { code: 'CAD' },
            taxTotal: { value: '0.00' },
            total: { value: '25.00' },
          },
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const result = await guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: create,
  });

  assert.equal(seen.url, WAVE_GRAPHQL_URL);
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization,
    'Bearer synthetic-token-never-sent-to-wave-123456');
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.options.body), {
    query: create.query,
    variables: create.variables,
  });
  assert.equal(JSON.parse(seen.options.body).variables.input.businessId,
    'wave-business-authorized-test');
  assert.equal(result.operationName, 'FacturationsCreateInvoice');
  assert.equal(result.networkPerformed, true);
  assert.equal(result.endpoint, WAVE_GRAPHQL_URL);
  assert.equal(result.payload.data.invoiceCreate.didSucceed, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token-never-sent/);
  assert.equal(Object.hasOwn(guarded, 'token'), false);
});

test('adapter rejects arbitrary GraphQL and cross-business mutation before fetch', async () => {
  let calls = 0;
  const guarded = adapter(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  });
  const create = buildWaveInvoiceCreateMutation(plan());

  await assert.rejects(guarded.execute({
    businessId: 'other-wave-business',
    request: create,
  }), expectNetwork('WAVE_BUSINESS_SCOPE_MISMATCH', { unknown: false, statusCode: 403 }));

  await assert.rejects(guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: { ...create, query: 'mutation Dangerous { anything }' },
  }), expectNetwork('UNAPPROVED_GRAPHQL_OPERATION', { unknown: false, statusCode: 403 }));

  await assert.rejects(guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: { ...create, networkPerformed: true },
  }), expectNetwork('MUTATION_ALREADY_MARKED_NETWORKED', { unknown: false, statusCode: 409 }));

  assert.equal(calls, 0);
});

test('approve contract is accepted but cannot be replaced with another invoice id', async () => {
  let calls = 0;
  const guarded = adapter(async () => {
    calls++;
    return new Response(JSON.stringify({
      data: {
        invoiceApprove: {
          didSucceed: true,
          inputErrors: [],
          invoice: {
            id: 'synthetic-provider-invoice',
            invoiceNumber: 'SYNTHETIC-1001',
            status: 'SAVED',
            customer: { id: 'wave-customer-synthetic' },
            currency: { code: 'CAD' },
            taxTotal: { value: '0.00' },
            total: { value: '25.00' },
          },
        },
      },
    }), { status: 200 });
  });
  const approve = buildWaveInvoiceApproveMutation('synthetic-provider-invoice');
  const result = await guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: approve,
  });
  assert.equal(result.operationName, 'FacturationsApproveInvoice');
  assert.equal(calls, 1);

  await assert.rejects(guarded.execute({
    businessId: 'wave-business-authorized-test',
    request: {
      ...approve,
      variables: { input: { invoiceId: 'other-invoice' } },
    },
  }), expectNetwork('WAVE_INVOICE_SCOPE_MISMATCH', { unknown: false, statusCode: 409 }));
  assert.equal(calls, 1);
});

test('transport timeout or unreadable successful response is treated as outcome-unknown', async () => {
  const timeout = new Error('synthetic timeout');
  timeout.name = 'TimeoutError';
  const timed = adapter(async () => { throw timeout; });
  await assert.rejects(timed.execute({
    businessId: 'wave-business-authorized-test',
    request: buildWaveInvoiceCreateMutation(plan()),
  }), expectNetwork('WAVE_MUTATION_TIMEOUT_UNKNOWN', { unknown: true, statusCode: 504 }));

  const invalid = adapter(async () => new Response('not-json', { status: 200 }));
  await assert.rejects(invalid.execute({
    businessId: 'wave-business-authorized-test',
    request: buildWaveInvoiceCreateMutation(plan()),
  }), expectNetwork('WAVE_MUTATION_INVALID_RESPONSE', { unknown: true, statusCode: 502 }));
});

test('HTTP authentication rejection is final while upstream 5xx is outcome-unknown', async () => {
  const unauthorized = adapter(async () => new Response('{}', { status: 401 }));
  await assert.rejects(unauthorized.execute({
    businessId: 'wave-business-authorized-test',
    request: buildWaveInvoiceCreateMutation(plan()),
  }), expectNetwork('WAVE_MUTATION_AUTH_FAILED', { unknown: false, statusCode: 502 }));

  const upstream = adapter(async () => new Response('{}', { status: 503 }));
  await assert.rejects(upstream.execute({
    businessId: 'wave-business-authorized-test',
    request: buildWaveInvoiceCreateMutation(plan()),
  }), expectNetwork('WAVE_MUTATION_UPSTREAM_UNKNOWN', { unknown: true, statusCode: 502 }));
});
