'use strict';

// Keep Stripe's signed payload byte-for-byte intact and bounded. Never parse,
// normalize or log the body before signature verification.
const { StripeWebhookError } = require('./stripe-payment-webhook');

const STRIPE_RAW_BODY_MAX_BYTES = 1_048_576;

function readStripeRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    function fail(code, statusCode = 400) {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      // Stop receiving data while the route returns an error. The HTTP 413
      // response explicitly closes the connection rather than draining a
      // potentially unbounded request body.
      request.pause();
      reject(new StripeWebhookError(code, statusCode));
    }

    request.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > STRIPE_RAW_BODY_MAX_BYTES) {
        fail('BODY_TOO_LARGE', 413);
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, length));
    });
    // A peer may disconnect halfway through a declared Content-Length.
    // Without close/aborted handling this promise could remain unresolved.
    request.once('aborted', () => fail('BODY_READ_FAILED'));
    request.once('close', () => fail('BODY_READ_FAILED'));
    request.once('error', () => fail('BODY_READ_FAILED'));

    const declared = request.headers && request.headers['content-length'];
    if (declared !== undefined) {
      if (typeof declared !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
          !Number.isSafeInteger(Number(declared))) {
        fail('BODY_READ_FAILED');
        return;
      }
      if (Number(declared) > STRIPE_RAW_BODY_MAX_BYTES) {
        fail('BODY_TOO_LARGE', 413);
        return;
      }
    }
    if (request.destroyed || request.aborted) fail('BODY_READ_FAILED');
  });
}

module.exports = { readStripeRawBody, STRIPE_RAW_BODY_MAX_BYTES };
