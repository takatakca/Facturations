'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const { createOperationalLogger } = require('../src/operational-logger');
const { attachRequestObservability, routeTemplate } = require('../src/request-observability');

test('route templates never expose query strings or dynamic IDs', () => {
  assert.equal(
    routeTemplate('/portal/access?token=very-secret'),
    '/portal/access'
  );
  assert.equal(
    routeTemplate('/portal/documents/11111111-1111-4111-8111-111111111111.pdf?download=1'),
    '/portal/documents/:id.pdf'
  );
  assert.equal(
    routeTemplate('/internal/review/11111111-1111-4111-8111-111111111111/print?lang=fr'),
    '/internal/review/:id/print'
  );
  assert.equal(
    routeTemplate('/private/sensitive-value?email=secret@example.test'),
    '/other'
  );
});

test('request observability adds server correlation ID and emits redacted structured log', async () => {
  const lines = [];
  const logger = createOperationalLogger({
    writeInfo: line => lines.push(line),
    writeError: line => lines.push(line),
  });
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://localhost').pathname === '/ready') {
      response.statusCode = 503;
    }
    response.end('ok');
  });
  attachRequestObservability(server, {
    logger,
    idFactory: () => '11111111-1111-4111-8111-111111111111',
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const first = await fetch(base + '/portal/access?token=very-secret');
    await first.text();
    assert.equal(
      first.headers.get('x-request-id'),
      '11111111-1111-4111-8111-111111111111'
    );

    const second = await fetch(base + '/ready?database=hidden');
    await second.text();

    const third = await fetch(base + '/private/sensitive-value?email=secret@example.test');
    await third.text();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  assert.equal(lines.length, 3);
  const events = lines.map(line => JSON.parse(line));
  assert.equal(events[0].route, '/portal/access');
  assert.equal(events[1].route, '/ready');
  assert.equal(events[1].level, 'error');
  assert.equal(events[1].statusCode, 503);
  assert.equal(events[2].route, '/other');

  const serialized = lines.join('\n');
  for (const secret of [
    'very-secret',
    'database=hidden',
    'secret@example.test',
    'sensitive-value',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});
