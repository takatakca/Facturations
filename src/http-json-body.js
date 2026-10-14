'use strict';

const { TextDecoder } = require('node:util');

const MAX_JSON_BODY_BYTES = 32_768;

/**
 * Reads one bounded JSON request body. Malformed UTF-8 is rejected rather
 * than silently replacing bytes, and a disconnected client cannot strand
 * a pending handler. This does not authenticate or authorize requests.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];

    function fail(code, statusCode = 400) {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.pause();
      reject({ code, statusCode });
    }

    request.once('aborted', () => fail('INVALID_REQUEST'));
    request.once('close', () => fail('INVALID_REQUEST'));
    request.once('error', () => fail('INVALID_REQUEST'));
    request.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        fail('BODY_TOO_LARGE', 413);
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
        resolve(JSON.parse(text));
      } catch {
        reject({ code: 'INVALID_JSON', statusCode: 400 });
      }
    });

    const declared = request.headers && request.headers['content-length'];
    if (declared !== undefined) {
      if (typeof declared !== 'string' ||
          !/^[0-9]+$/u.test(declared) ||
          !Number.isSafeInteger(Number(declared))) {
        fail('INVALID_REQUEST');
      } else if (Number(declared) > MAX_JSON_BODY_BYTES) {
        fail('BODY_TOO_LARGE', 413);
      }
    }
    if (request.destroyed || request.aborted) fail('INVALID_REQUEST');
  });
}

module.exports = { readJsonBody, MAX_JSON_BODY_BYTES };
