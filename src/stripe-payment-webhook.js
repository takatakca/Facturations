'use strict';

// Stripe payment webhooks -> verified payment evidence.
// Facturations verifies Stripe's signature itself (no SDK, no trust in the
// caller): HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret, within
// a bounded clock tolerance, compared in constant time. Only after that is
// the body parsed. Only completed, paid Checkout Sessions created for this
// business and an exact issued invoice become evidence.

const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERIFICATION_SCHEME = 'STRIPE_SIGNATURE_V1';
const PROVIDER_KEY = 'STRIPE';
const DEFAULT_TOLERANCE_SECONDS = 300;
const PAID_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

class StripeWebhookError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'StripeWebhookError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/=_-]{24,}$/u.test(secret)) {
    throw new StripeWebhookError('STRIPE_WEBHOOK_NOT_CONFIGURED', 503);
  }
  return secret;
}

function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.length < 1 || header.length > 4096) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && /^[0-9]{1,12}$/u.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/u.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0 || signatures.length > 10) return null;
  return { timestamp, signatures };
}

/**
 * Verifies a Stripe webhook and returns the parsed event plus the SHA-256
 * of the exact raw body. Throws StripeWebhookError on any failure.
 */
function verifyStripeWebhook({
  rawBody,
  signatureHeader,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
} = {}) {
  const key = validateSecret(secret);
  if (!Buffer.isBuffer(rawBody) || rawBody.length < 2 || rawBody.length > 1_048_576) {
    throw new StripeWebhookError('INVALID_WEBHOOK_BODY');
  }
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) throw new StripeWebhookError('INVALID_STRIPE_SIGNATURE_HEADER');
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new StripeWebhookError('STRIPE_SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE');
  }
  const expected = crypto.createHmac('sha256', key)
    .update(`${parsed.timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  const valid = parsed.signatures.some(signature =>
    signature.length === expected.length && crypto.timingSafeEqual(signature, expected));
  if (!valid) throw new StripeWebhookError('STRIPE_SIGNATURE_VERIFICATION_FAILED');

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new StripeWebhookError('INVALID_WEBHOOK_JSON');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]{6,200}$/u.test(event.id) ||
      typeof event.type !== 'string') {
    throw new StripeWebhookError('INVALID_STRIPE_EVENT');
  }
  return Object.freeze({
    event,
    rawBodySha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
    verificationScheme: VERIFICATION_SCHEME,
  });
}

/**
 * Maps a verified Stripe event to a payment evidence request, or returns
 * { relevant: false, reason } for events this ledger does not record.
 */
function stripeEventToPaymentEvidence(event, { businessId }) {
  if (!PAID_EVENT_TYPES.has(event.type)) return { relevant: false, reason: 'EVENT_TYPE_IGNORED' };
  const session = event.data && event.data.object;
  if (!session || typeof session !== 'object' || session.object !== 'checkout.session') {
    return { relevant: false, reason: 'NOT_A_CHECKOUT_SESSION' };
  }
  const metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  if (metadata.facturations_business_id !== businessId) {
    return { relevant: false, reason: 'OTHER_BUSINESS' };
  }
  if (typeof metadata.facturations_issued_invoice_id !== 'string' ||
      !UUID.test(metadata.facturations_issued_invoice_id)) {
    throw new StripeWebhookError('STRIPE_SESSION_INVOICE_REFERENCE_INVALID', 422);
  }
  if (session.mode !== 'payment' || session.payment_status !== 'paid') {
    return { relevant: false, reason: 'SESSION_NOT_PAID' };
  }
  if (session.currency !== 'cad' || !Number.isSafeInteger(session.amount_total) || session.amount_total < 1) {
    throw new StripeWebhookError('STRIPE_SESSION_AMOUNT_INVALID', 422);
  }
  const paymentIntent = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent && session.payment_intent.id;
  if (typeof paymentIntent !== 'string' || !/^pi_[A-Za-z0-9]{6,200}$/u.test(paymentIntent)) {
    throw new StripeWebhookError('STRIPE_SESSION_PAYMENT_INTENT_INVALID', 422);
  }
  if (!Number.isSafeInteger(event.created) || event.created < 1) {
    throw new StripeWebhookError('INVALID_STRIPE_EVENT', 422);
  }
  return {
    relevant: true,
    issuedInvoiceId: metadata.facturations_issued_invoice_id.toLowerCase(),
    event: Object.freeze({
      providerKey: PROVIDER_KEY,
      eventId: event.id,
      providerTransactionId: paymentIntent,
      eventType: 'PAYMENT_RECEIVED',
      amountCents: session.amount_total,
      currency: 'CAD',
      occurredAt: new Date(event.created * 1000).toISOString(),
    }),
  };
}

const REVERSAL_EVENT_TYPES = new Set([
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
]);

function paymentIntentOf(object) {
  const value = typeof object.payment_intent === 'string'
    ? object.payment_intent
    : object.payment_intent && object.payment_intent.id;
  return typeof value === 'string' && /^pi_[A-Za-z0-9]{6,200}$/u.test(value) ? value : null;
}

function reversal({ kind, id, paymentIntent, amount, created }) {
  // A reversal that takes money back is REFUND_ISSUED against the payment;
  // a reversal of that reversal (failed refund, won dispute) is an offsetting
  // PAYMENT_RECEIVED. The ledger stays append-only and the balance correct.
  const takesMoneyBack = kind === 'REFUND_ISSUED' || kind === 'DISPUTE_WITHDRAWN';
  const transactionId = kind === 'REFUND_ISSUED' ? id
    : kind === 'REFUND_REVERSED' ? `${id}:reversed`
      : kind === 'DISPUTE_WITHDRAWN' ? `${id}:withdrawn`
        : `${id}:reinstated`;
  return {
    relevant: true,
    kind,
    paymentIntent,
    // The base evidence a reversal-of-reversal requires (null otherwise).
    requiresTransactionId: kind === 'REFUND_REVERSED' ? id
      : kind === 'DISPUTE_REINSTATED' ? `${id}:withdrawn` : null,
    requiresEventType: kind === 'REFUND_REVERSED' || kind === 'DISPUTE_REINSTATED' ? 'REFUND_ISSUED' : null,
    event: Object.freeze({
      providerKey: PROVIDER_KEY,
      eventId: transactionId,
      providerTransactionId: transactionId,
      ...(takesMoneyBack ? { relatedProviderTransactionId: paymentIntent } : {}),
      eventType: takesMoneyBack ? 'REFUND_ISSUED' : 'PAYMENT_RECEIVED',
      amountCents: amount,
      currency: 'CAD',
      occurredAt: new Date(created * 1000).toISOString(),
    }),
  };
}

/**
 * Maps a verified Stripe refund or dispute event to a reversal. Identifiers
 * and occurredAt come from the refund/dispute object itself, so every event
 * about one refund (created, updated) is the SAME evidence (idempotent).
 * Refunds count once succeeded; a refund failing after that, and a dispute
 * won after its funds were withdrawn, are recorded as offsetting entries.
 * The caller resolves the issued invoice from the recorded payment.
 */
function stripeEventToReversal(event) {
  if (!REVERSAL_EVENT_TYPES.has(event.type)) return { relevant: false, reason: 'EVENT_TYPE_IGNORED' };
  const object = event.data && event.data.object;
  const isRefund = event.type.startsWith('refund.');
  if (!object || typeof object !== 'object' || object.object !== (isRefund ? 'refund' : 'dispute')) {
    return { relevant: false, reason: 'UNEXPECTED_OBJECT' };
  }
  const paymentIntent = paymentIntentOf(object);
  if (!paymentIntent) return { relevant: false, reason: 'NOT_A_PAYMENT_INTENT_REVERSAL' };

  let kind;
  if (isRefund) {
    if (object.status === 'succeeded' && event.type !== 'refund.failed') kind = 'REFUND_ISSUED';
    else if (object.status === 'failed' || object.status === 'canceled') kind = 'REFUND_REVERSED';
    else return { relevant: false, reason: 'REFUND_NOT_FINAL' };
  } else {
    kind = event.type === 'charge.dispute.funds_withdrawn' ? 'DISPUTE_WITHDRAWN' : 'DISPUTE_REINSTATED';
  }

  const idPattern = isRefund ? /^(re|pyr)_[A-Za-z0-9]{6,200}$/u : /^dp_[A-Za-z0-9]{6,200}$/u;
  if (typeof object.id !== 'string' || !idPattern.test(object.id) ||
      object.currency !== 'cad' || !Number.isSafeInteger(object.amount) || object.amount < 1 ||
      !Number.isSafeInteger(object.created) || object.created < 1) {
    throw new StripeWebhookError('STRIPE_REVERSAL_INVALID', 422);
  }
  return reversal({ kind, id: object.id, paymentIntent, amount: object.amount, created: object.created });
}

/** Rebuilds a reversal from a stored pending row (see migration 046). */
function reversalFromPendingRow(row) {
  const id = String(row.provider_event_id).replace(/:(reversed|withdrawn|reinstated)$/u, '');
  return reversal({
    kind: row.reversal_kind,
    id,
    paymentIntent: row.payment_intent_id,
    amount: Number(row.amount_cents),
    created: Math.floor(new Date(row.occurred_at).getTime() / 1000),
  });
}

/**
 * Only live-mode events from the platform account itself. Events from
 * connected accounts (event.account) are never payments to GROUPE TAKATAK,
 * and test-mode events are accepted only when explicitly allowed (staging).
 */
function stripeEventScope(event, { allowTestMode = false } = {}) {
  if (event.account !== undefined && event.account !== null) return { accepted: false, reason: 'CONNECTED_ACCOUNT_EVENT' };
  if (event.livemode !== true && !allowTestMode) return { accepted: false, reason: 'TEST_MODE_EVENT' };
  return { accepted: true };
}

module.exports = {
  PROVIDER_KEY,
  VERIFICATION_SCHEME,
  StripeWebhookError,
  verifyStripeWebhook,
  stripeEventToPaymentEvidence,
  stripeEventToReversal,
  reversalFromPendingRow,
  stripeEventScope,
};
