'use strict';

// POST /webhooks/stripe/payments — Stripe-signed payment webhooks.
// Raw body is read with a hard cap, verified by verifyStripeWebhook(), then
// mapped to verified payment evidence. Responses never echo provider data.
// 2xx = recorded, duplicate or deliberately ignored; 4xx/5xx = Stripe retries.

const {
  StripeWebhookError,
  verifyStripeWebhook,
  stripeEventToPaymentEvidence,
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

function attachStripePaymentWebhook(server, { secret, businessId, evidenceStore, now = Date.now }) {
  if (!server || typeof server.listeners !== 'function' || server.listeners('request').length !== 1 ||
      typeof businessId !== 'string' || !businessId ||
      !evidenceStore || typeof evidenceStore.ingestVerifiedStripe !== 'function' ||
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
      const mapped = stripeEventToPaymentEvidence(verified.event, { businessId });
      if (!mapped.relevant) return reply(response, 200, { received: true, recorded: false });
      await evidenceStore.ingestVerifiedStripe({
        issuedInvoiceId: mapped.issuedInvoiceId,
        event: mapped.event,
        rawBodySha256: verified.rawBodySha256,
        verificationScheme: verified.verificationScheme,
      });
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
