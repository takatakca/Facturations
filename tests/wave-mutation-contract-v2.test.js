'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WAVE_INVOICE_CREATE_MUTATION,
  WAVE_INVOICE_APPROVE_MUTATION,
  WaveMutationContractError,
  buildWaveInvoiceCreateMutation,
  buildWaveInvoiceApproveMutation,
  classifyCreatePayload,
  classifyApprovePayload,
} = require('../src/wave-mutation-contract-v2');

function plan(overrides = {}) {
  return {
    status: 'READY_FOR_WAVE_ADAPTER',
    operation: 'CREATE_DRAFT_THEN_APPROVE_SEPARATELY',
    businessId: 'wave-business-synthetic',
    customerId: 'wave-customer-synthetic',
    currency: 'CAD',
    invoiceDate: '2026-09-23',
    dueDate: '2026-10-23',
    memo: 'Synthetic only',
    items: [{
      productId: 'wave-product-synthetic',
      description: 'Synthetic service',
      quantity: 2,
      unitPriceCents: 1250,
      taxable: true,
      salesTaxIds: ['wave-tax-synthetic'],
    }],
    expected: {
      customerEmail: 'customer@example.test',
      subtotalCents: 2500,
      taxTotalCents: 125,
      totalCents: 2625,
    },
    externalActionsPerformed: {
      createInvoice: false,
      approveInvoice: false,
      sendInvoice: false,
    },
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: 'wave-invoice-synthetic',
    invoiceNumber: 'SYNTHETIC-1001',
    status: 'DRAFT',
    customer: { id: 'wave-customer-synthetic' },
    currency: { code: 'CAD' },
    taxTotal: { value: '1.25' },
    total: { value: '26.25' },
    ...overrides,
  };
}

test('builds fixed invoiceCreate DRAFT mutation only from persisted plan shape', () => {
  const request = buildWaveInvoiceCreateMutation(plan());
  assert.equal(request.operationName, 'FacturationsCreateInvoice');
  assert.equal(request.query, WAVE_INVOICE_CREATE_MUTATION);
  assert.equal(request.networkPerformed, false);
  assert.equal(request.variables.input.businessId, 'wave-business-synthetic');
  assert.equal(request.variables.input.customerId, 'wave-customer-synthetic');
  assert.equal(request.variables.input.status, 'DRAFT');
  assert.equal(request.variables.input.currency, 'CAD');
  assert.equal(request.variables.input.items[0].quantity, '2');
  assert.equal(request.variables.input.items[0].unitPrice, '12.50');
  assert.deepEqual(request.variables.input.items[0].taxes,
    [{ salesTaxId: 'wave-tax-synthetic' }]);

  assert.equal(Object.hasOwn(request.variables.input, 'invoiceNumber'), false,
    'Wave numbering is not invented locally');
  assert.equal(Object.hasOwn(request.variables.input, 'discounts'), false,
    'line discounts remain blocked by the preflight rather than approximated');
  assert.equal(Object.hasOwn(request.variables.input.items[0].taxes[0], 'amount'), false,
    'deprecated Wave tax amount is never sent');
  assert.doesNotMatch(JSON.stringify(request), /access.?token|authorization/i);
});

test('builds invoiceApprove as a separate fixed mutation', () => {
  const request = buildWaveInvoiceApproveMutation('wave-invoice-synthetic');
  assert.equal(request.operationName, 'FacturationsApproveInvoice');
  assert.equal(request.query, WAVE_INVOICE_APPROVE_MUTATION);
  assert.deepEqual(request.variables, {
    input: { invoiceId: 'wave-invoice-synthetic' },
  });
  assert.equal(request.expectedInvoiceId, 'wave-invoice-synthetic');
  assert.equal(request.networkPerformed, false);
});

test('contract rejects provider actions already performed, hidden fields and unsafe item mapping', () => {
  assert.throws(() => buildWaveInvoiceCreateMutation(plan({
    externalActionsPerformed: {
      createInvoice: true, approveInvoice: false, sendInvoice: false,
    },
  })), error => error instanceof WaveMutationContractError &&
    error.code === 'WAVE_ACTION_ALREADY_PERFORMED');

  assert.throws(() => buildWaveInvoiceCreateMutation({
    ...plan(),
    token: 'must-never-be-accepted',
  }), error => error instanceof WaveMutationContractError &&
    error.code === 'INVALID_WAVE_PLAN');

  const badTax = plan();
  badTax.items = [{
    ...badTax.items[0],
    taxable: false,
    salesTaxIds: ['wave-tax-synthetic'],
  }];
  assert.throws(() => buildWaveInvoiceCreateMutation(badTax), error =>
    error instanceof WaveMutationContractError &&
    error.code === 'NON_TAXABLE_ITEM_HAS_TAXES');

  const duplicateTaxes = plan();
  duplicateTaxes.items = [{
    ...duplicateTaxes.items[0],
    salesTaxIds: ['wave-tax-synthetic', 'wave-tax-synthetic'],
  }];
  assert.throws(() => buildWaveInvoiceCreateMutation(duplicateTaxes), error =>
    error instanceof WaveMutationContractError &&
    error.code === 'INVALID_WAVE_TAX_IDS');

  assert.throws(() => buildWaveInvoiceCreateMutation(plan({
    invoiceDate: '2026-02-31',
  })), error => error instanceof WaveMutationContractError &&
    error.code === 'INVALID_WAVE_INVOICE_DATE');

  assert.throws(() => buildWaveInvoiceCreateMutation(plan({
    invoiceDate: '2026-10-24',
    dueDate: '2026-10-23',
  })), error => error instanceof WaveMutationContractError &&
    error.code === 'WAVE_DUE_DATE_BEFORE_INVOICE_DATE');
});

test('create classifier only confirms a matching DRAFT and never treats it as approved', () => {
  const request = buildWaveInvoiceCreateMutation(plan());
  const result = classifyCreatePayload({
    data: {
      invoiceCreate: {
        didSucceed: true,
        inputErrors: [],
        invoice: invoice(),
      },
    },
  }, request);
  assert.deepEqual(result, {
    outcome: 'CREATE_CONFIRMED_DRAFT_ONLY',
    providerInvoiceId: 'wave-invoice-synthetic',
    providerStatus: 'DRAFT',
    providerInvoiceNumber: 'SYNTHETIC-1001',
    approved: false,
    emailed: false,
  });

  const mismatch = classifyCreatePayload({
    data: {
      invoiceCreate: {
        didSucceed: true,
        inputErrors: [],
        invoice: invoice({ total: { value: '26.26' } }),
      },
    },
  }, request);
  assert.deepEqual(mismatch, {
    outcome: 'AMBIGUOUS',
    reason: 'CREATE_RESULT_MISMATCH',
  });

  const graphQl = classifyCreatePayload({
    errors: [{ message: 'Synthetic uncertain response' }],
  }, request);
  assert.deepEqual(graphQl, { outcome: 'AMBIGUOUS', reason: 'GRAPHQL_ERRORS' });
});

test('approve classifier requires same invoice, SAVED state, exact totals and official number', () => {
  const create = buildWaveInvoiceCreateMutation(plan());
  const approve = buildWaveInvoiceApproveMutation('wave-invoice-synthetic');
  const result = classifyApprovePayload({
    data: {
      invoiceApprove: {
        didSucceed: true,
        inputErrors: [],
        invoice: invoice({ status: 'SAVED' }),
      },
    },
  }, approve, create.expected);

  assert.deepEqual(result, {
    outcome: 'APPROVE_CONFIRMED',
    providerInvoiceId: 'wave-invoice-synthetic',
    officialInvoiceNumber: 'SYNTHETIC-1001',
    providerStatus: 'SAVED',
    emailed: false,
  });

  const wrongInvoice = classifyApprovePayload({
    data: {
      invoiceApprove: {
        didSucceed: true,
        inputErrors: [],
        invoice: invoice({ id: 'other-wave-invoice', status: 'SAVED' }),
      },
    },
  }, approve, create.expected);
  assert.deepEqual(wrongInvoice, {
    outcome: 'AMBIGUOUS',
    reason: 'APPROVE_RESULT_MISMATCH',
  });

  const stillDraft = classifyApprovePayload({
    data: {
      invoiceApprove: {
        didSucceed: true,
        inputErrors: [],
        invoice: invoice({ status: 'DRAFT' }),
      },
    },
  }, approve, create.expected);
  assert.deepEqual(stillDraft, {
    outcome: 'AMBIGUOUS',
    reason: 'APPROVE_RESULT_MISMATCH',
  });
});

test('mutation validation failures are terminal but unconfirmed failures remain ambiguous', () => {
  const create = buildWaveInvoiceCreateMutation(plan());
  const approve = buildWaveInvoiceApproveMutation('wave-invoice-synthetic');

  const invalid = classifyCreatePayload({
    data: {
      invoiceCreate: {
        didSucceed: false,
        inputErrors: [{
          code: 'INVALID_INPUT',
          message: 'Synthetic validation failure',
          path: ['input', 'customerId'],
        }],
        invoice: null,
      },
    },
  }, create);
  assert.equal(invalid.outcome, 'FAILED_FINAL');
  assert.equal(invalid.reason, 'INPUT_ERRORS');
  assert.equal(invalid.inputErrors[0].code, 'INVALID_INPUT');

  const uncertain = classifyApprovePayload({
    data: {
      invoiceApprove: {
        didSucceed: false,
        inputErrors: [],
        invoice: null,
      },
    },
  }, approve, create.expected);
  assert.deepEqual(uncertain, {
    outcome: 'AMBIGUOUS',
    reason: 'UNCONFIRMED_APPROVE_FAILURE',
    inputErrors: [],
  });
});
