'use strict';

// POST /webhooks/stripe/payments — Stripe-signed payment webhooks.
// Raw body is read with a hard cap, verified by verifyStripeWebhook(), then
// mapped to verified payment evidence. Responses never echo provider data.
// 2xx = recorded, duplicate or deliberately ignored; 4xx/5xx = Stripe retries.

const {
  StripeWebhookError,
  verifyStripeWebhook,
  stripeEventToPaymentEvidence,
  stripeEventToReversal,
  reversalFromPendingRow,
  stripeEventScope,
} = require('./stripe-payment-webhook');

const PATH = '/webhooks/stripe/payments';
const MAX_BYTES = 1_048_576;

function reply(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'] || '0');
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      reject(new StripeWebhookError('BODY_TOO_LARGE', 413));
      return;
    }
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BYTES) {
        reject(new StripeWebhookError('BODY_TOO_LARGE', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => reject(new StripeWebhookError('BODY_READ_FAILED', 400)));
  });
}

const REVERSAL_ORDER = ['REFUND_ISSUED', 'DISPUTE_WITHDRAWN', 'REFUND_REVERSED', 'DISPUTE_REINSTATED'];

async function canApply(evidenceStore, reversal) {
  return !reversal.requiresTransactionId ||
    evidenceStore.hasEvidenceForTransaction(reversal.requiresTransactionId, reversal.requiresEventType);
}

/**
 * Applies the stored reversals of one PaymentIntent once its payment is
 * recorded. Idempotent: evidence ids are stable, so re-applying is a no-op.
 */
async function applyPendingReversals(evidenceStore, paymentIntent, issuedInvoiceId) {
  const rows = await evidenceStore.listPendingStripeReversals(paymentIntent);
  const ordered = [...rows].sort((a, b) =>
    new Date(a.occurred_at) - new Date(b.occurred_at) ||
    REVERSAL_ORDER.indexOf(a.reversal_kind) - REVERSAL_ORDER.indexOf(b.reversal_kind));
  for (const row of ordered) {
    const reversal = reversalFromPendingRow(row);
    if (!(await canApply(evidenceStore, reversal))) continue;
    try {
      await evidenceStore.ingestVerifiedStripe({
        issuedInvoiceId,
        event: reversal.event,
        rawBodySha256: row.webhook_body_sha256,
        verificationScheme: 'STRIPE_SIGNATURE_V1',
      });
    } catch (error) {
      if (!error || error.name !== 'PaymentEvidenceError') throw error;
      // A reversal the ledger refuses (e.g. it would exceed the payment)
      // stays pending for an operator; it never blocks the payment itself.
    }
  }
}

function attachStripePaymentWebhook(server, { secret, businessId, evidenceStore, allowTestMode = false, now = Date.now }) {
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      typeof businessId !== 'string' || !businessId ||
      !evidenceStore || typeof evidenceStore.ingestVerifiedStripe !== 'function' ||
      typeof evidenceStore.findIssuedInvoiceByPaymentTransaction !== 'function' ||
      typeof evidenceStore.hasEvidenceForTransaction !== 'function' ||
      typeof evidenceStore.recordPendingStripeReversal !== 'function' ||
      typeof evidenceStore.listPendingStripeReversals !== 'function' ||
      evidenceStore.providerKey !== 'STRIPE') {
    throw new TypeError('Stripe payment webhook requires one handler, business and STRIPE evidence store');
  }
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return handler(request, response); }
    if (url.pathname !== PATH) return handler(request, response);
    if (request.method !== 'POST') return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if ([...url.searchParams.keys()].length) return reply(response, 422, { error: 'INVALID_QUERY' });

    try {
      const rawBody = await readRawBody(request);
      const verified = verifyStripeWebhook({
        rawBody,
        signatureHeader: request.headers['stripe-signature'],
        secret,
        nowMs: now(),
      });
      const ignored = () => reply(response, 200, { received: true, recorded: false });
      if (!stripeEventScope(verified.event, { allowTestMode }).accepted) return ignored();
      const provenance = { rawBodySha256: verified.rawBodySha256, verificationScheme: verified.verificationScheme };

      const payment = stripeEventToPaymentEvidence(verified.event, { businessId });
      if (payment.relevant) {
        await evidenceStore.ingestVerifiedStripe({ issuedInvoiceId: payment.issuedInvoiceId, event: payment.event, ...provenance });
        await applyPendingReversals(evidenceStore, payment.event.providerTransactionId, payment.issuedInvoiceId);
        return reply(response, 200, { received: true, recorded: true });
      }

      const reversal = stripeEventToReversal(verified.event);
      if (!reversal.relevant) return ignored();
      // Reversals carry no invoice metadata: the invoice is the one whose
      // payment used this PaymentIntent. When that payment (or the reversal
      // this one undoes) is not recorded yet, keep it until it is. Reversals
      // of other products on the same Stripe account just stay unmatched.
      const issuedInvoiceId = await evidenceStore.findIssuedInvoiceByPaymentTransaction(reversal.paymentIntent);
      if (!issuedInvoiceId || !(await canApply(evidenceStore, reversal))) {
        await evidenceStore.recordPendingStripeReversal({
          kind: reversal.kind,
          eventId: reversal.event.eventId,
          paymentIntent: reversal.paymentIntent,
          amountCents: reversal.event.amountCents,
          occurredAt: reversal.event.occurredAt,
          rawBodySha256: verified.rawBodySha256,
        });
        return reply(response, 200, { received: true, recorded: false, pending: true });
      }
      await evidenceStore.ingestVerifiedStripe({ issuedInvoiceId, event: reversal.event, ...provenance });
      await applyPendingReversals(evidenceStore, reversal.paymentIntent, issuedInvoiceId);
      return reply(response, 200, { received: true, recorded: true });
    } catch (error) {
      if (error instanceof StripeWebhookError) {
        return reply(response, error.statusCode, { error: error.code });
      }
      if (error && error.name === 'PaymentEvidenceError' && Number.isInteger(error.statusCode)) {
        return reply(response, error.statusCode, { error: error.code });
      }
      return reply(response, 503, { error: 'STORAGE_UNAVAILABLE' });
    }
  });
  return server;
}

module.exports = { attachStripePaymentWebhook, STRIPE_PAYMENT_WEBHOOK_PATH: PATH };
