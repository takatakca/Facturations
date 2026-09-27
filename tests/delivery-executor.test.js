'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeliveryExecutor, DeliveryExecutorError } = require('../src/delivery-executor');
const { DeliveryAttemptError } = require('../src/delivery-attempt-store');

function fakeAttemptStore() {
  let state = 'PREPARED';
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    authorizationId: '22222222-2222-4222-8222-222222222222',
    issuedInvoiceId: '33333333-3333-4333-8333-333333333333',
    qualifiedDocumentId: '44444444-4444-4444-8444-444444444444',
    provider: 'SIMULATED_EMAIL',
    operationKey: 'mail_test_operation_key_abcdefghijklmnopqrstuvwxyz',
  };
  const current = extra => Object.freeze({ ...base, state, ...extra });
  return {
    async get() { return current({}); },
    async start() {
      if (state !== 'PREPARED') {
        throw new DeliveryAttemptError(
          state === 'AMBIGUOUS' ? 'AMBIGUOUS_REQUIRES_RECONCILIATION' : 'INVALID_ATTEMPT_STATE',
          409
        );
      }
      state = 'IN_PROGRESS';
      return current({});
    },
    async markAmbiguous({ reasonCode }) {
      assert.equal(state, 'IN_PROGRESS');
      state = 'AMBIGUOUS';
      return current({ outcomeCode: reasonCode });
    },
    async markFailed({ reasonCode }) {
      assert.ok(['IN_PROGRESS', 'AMBIGUOUS'].includes(state));
      state = 'FAILED';
      return current({ outcomeCode: reasonCode });
    },
    async markConfirmed({ providerMessageId }) {
      assert.ok(['IN_PROGRESS', 'AMBIGUOUS'].includes(state));
      state = 'CONFIRMED';
      return current({ providerMessageId });
    },
  };
}

test('delivery adapter exception becomes AMBIGUOUS and blocks automatic retry until reconciliation', async () => {
  const attemptStore = fakeAttemptStore();
  let calls = 0;
  const executor = createDeliveryExecutor({
    attemptStore,
    adapter: {
      async sendDocument() {
        calls += 1;
        throw new Error('synthetic timeout');
      },
    },
  });

  const first = await executor.execute({
    attemptId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(first.state, 'AMBIGUOUS');
  assert.equal(first.outcomeCode, 'ADAPTER_EXCEPTION');
  assert.equal(calls, 1);

  await assert.rejects(
    executor.execute({ attemptId: first.id }),
    error => error instanceof DeliveryAttemptError &&
      error.code === 'AMBIGUOUS_REQUIRES_RECONCILIATION' &&
      error.statusCode === 409
  );
  assert.equal(calls, 1, 'ambiguous retry must not call adapter again');

  const reconciled = await executor.reconcile({
    attemptId: first.id,
    result: {
      status: 'CONFIRMED',
      providerMessageId: 'reconciled-message-123',
    },
  });
  assert.equal(reconciled.state, 'CONFIRMED');
  assert.equal(reconciled.providerMessageId, 'reconciled-message-123');
});

test('inconclusive reconciliation keeps an ambiguous delivery blocked', async () => {
  const attemptStore = fakeAttemptStore();
  const executor = createDeliveryExecutor({
    attemptStore,
    adapter: { async sendDocument() { return { status: 'AMBIGUOUS', reasonCode: 'UNKNOWN_RESULT' }; } },
  });
  const ambiguous = await executor.execute({
    attemptId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(ambiguous.state, 'AMBIGUOUS');

  await assert.rejects(
    executor.reconcile({
      attemptId: ambiguous.id,
      result: { status: 'AMBIGUOUS', reasonCode: 'STILL_UNKNOWN' },
    }),
    error => error instanceof DeliveryExecutorError &&
      error.code === 'RECONCILIATION_INCONCLUSIVE' &&
      error.statusCode === 409
  );
});
