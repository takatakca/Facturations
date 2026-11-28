'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { once } = require('node:events');
const { readJsonBody, MAX_JSON_BODY_BYTES } = require('../src/http-json-body');
const { createServer } = require('../src/server');

function fakeIncoming(headers = {}) {
  const request = new PassThrough();
  request.headers = headers;
  return request;
}

test('bounded JSON reader: accepts valid UTF-8 and preserves parsed payload', async () => {
  const body = Buffer.from('{"nom":"Café","amountCents":1200}', 'utf8');
  const request = fakeIncoming({ 'content-length': String(body.length) });
  const promise = readJsonBody(request);
  request.end(body);
  assert.deepEqual(await promise, { nom: 'Café', amountCents: 1200 });
});

test('bounded JSON reader: rejects malformed bytes and invalid JSON', async () => {
  for (const raw of [Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), Buffer.from('{"incomplete":', 'utf8')]) {
    const request = fakeIncoming();
    const promise = readJsonBody(request);
    request.end(raw);
    await assert.rejects(promise, error => error.code === 'INVALID_JSON' && error.statusCode === 400);
  }
});

test('bounded JSON reader: closes reading on invalid or oversized declared lengths', async () => {
  const cases = [
    ['wrong', 'INVALID_REQUEST', 400],
    ['9999999999999999999999999', 'INVALID_REQUEST', 400],
    [String(MAX_JSON_BODY_BYTES + 1), 'BODY_TOO_LARGE', 413],
  ];
  for (const [contentLength, code, statusCode] of cases) {
    const request = fakeIncoming({ 'content-length': contentLength });
    try {
      await assert.rejects(readJsonBody(request), error => error.code === code && error.statusCode === statusCode);
    } finally {
      request.destroy();
    }
  }
});

test('bounded JSON reader: streaming beyond limit rejects before parse', async () => {
  const request = fakeIncoming();
  const promise = readJsonBody(request);
  request.write(Buffer.alloc(MAX_JSON_BODY_BYTES, 0x61));
  request.write(Buffer.from('x'));
  await assert.rejects(promise, error => error.code === 'BODY_TOO_LARGE' && error.statusCode === 413);
  request.destroy();
});

test('bounded JSON reader: incomplete request on abort, close or error never hangs', async () => {
  for (const kind of ['aborted', 'close', 'error']) {
    const request = fakeIncoming({ 'content-length': '1000' });
    const promise = readJsonBody(request);
    request.write(Buffer.from('{"partial":'));
    if (kind === 'error') request.emit('error', new Error('synthetic transport'));
    else request.emit(kind);
    await assert.rejects(promise, error => error.code === 'INVALID_REQUEST' && error.statusCode === 400);
    request.destroy();
  }
});

test('draft HTTP endpoint: excessive declared payload returns 413 without store access', async () => {
  let writes = 0;
  const key = 'k'.repeat(64);
  const server = createServer({
    config: { adminKey: key },
    draftStore: { async createDraft() { writes++; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const answer = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/api/drafts',
        method: 'POST',
        agent: false,
        headers: {
          'X-Admin-Key': key,
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_JSON_BODY_BYTES + 1),
        },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          connection: res.headers.connection,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(answer.status, 413);
    assert.equal(answer.connection, 'close');
    assert.deepEqual(JSON.parse(answer.body), { error: 'BODY_TOO_LARGE' });
    assert.equal(writes, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
