'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { attachOperationalTelemetry, routeGroup } = require('../src/operational-telemetry');

const FIXED_ID = '12345678-1234-4123-8123-123456789abc';

async function withServer({ logger, handler, idFactory = () => FIXED_ID }, run) {
  const server = http.createServer(handler || ((_request, response) => {
    response.writeHead(204);
    response.end();
  }));
  attachOperationalTelemetry(server, {
    logger,
    idFactory,
    clock: (() => {
      let value = 1000;
      return () => value += 7;
    })(),
    timestamp: () => '2026-09-26T20:00:00.000Z',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('route classifier emits only bounded route groups and drops sensitive path/query values', () => {
  assert.equal(routeGroup('/portal/access?lang=fr&token=SUPER_SECRET_TOKEN'), 'PORTAL_ACCESS');
  assert.equal(routeGroup('/portal/invoices/11111111-1111-4111-8111-111111111111?email=a@b.test'), 'PORTAL_INVOICE');
  assert.equal(routeGroup('/portal/documents/22222222-2222-4222-8222-222222222222.pdf'), 'PORTAL_PDF');
  assert.equal(routeGroup('/internal/workspaces/private-user@example.test'), 'WORKSPACE_ITEM');
  assert.equal(routeGroup('/something/private-user@example.test?token=secret'), 'OTHER');
  assert.equal(routeGroup('/internal/assistant/help?private=ignored'), 'AI_ASSISTANT_HELP');
  assert.equal(routeGroup('/internal/assistant/propose-draft'), 'AI_DRAFT_PROPOSAL');
  assert.equal(routeGroup('/integration/v1/capabilities'), 'INTEGRATION_CAPABILITIES');
  assert.equal(routeGroup('/integration/v1/dashboard'), 'INTEGRATION_DASHBOARD');
  assert.equal(routeGroup('/integration/v1/drafts?page=2'), 'INTEGRATION_DRAFTS');
  assert.equal(routeGroup('/integration/v1/customers?q=private@example.test'), 'INTEGRATION_CUSTOMERS');
  assert.equal(routeGroup('http://[invalid'), 'OTHER');
});

test('telemetry ignores caller request IDs and logs one redacted JSON event', async () => {
  const lines = [];
  await withServer({ logger: line => lines.push(line) }, async base => {
    const response = await fetch(
      base + '/portal/access?lang=fr&token=THIS_MUST_NEVER_BE_LOGGED',
      {
        headers: {
          'X-Request-ID': 'attacker-controlled',
          Cookie: 'session=COOKIE_SECRET',
          'User-Agent': 'private-user@example.test',
        },
      }
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-request-id'), FIXED_ID);
  });

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.deepEqual(event, {
    ts: '2026-09-26T20:00:00.000Z',
    event: 'http_request',
    requestId: FIXED_ID,
    method: 'GET',
    route: 'PORTAL_ACCESS',
    statusCode: 204,
    durationMs: 7,
    outcome: 'finished',
  });
  for (const forbidden of [
    'THIS_MUST_NEVER_BE_LOGGED',
    'attacker-controlled',
    'COOKIE_SECRET',
    'private-user@example.test',
    '/portal/access',
    'token=',
  ]) {
    assert.equal(lines[0].includes(forbidden), false, forbidden + ' leaked to telemetry');
  }
});

test('dynamic UUID routes never place identifiers in logs', async () => {
  const lines = [];
  const secretUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await withServer({ logger: line => lines.push(line) }, async base => {
    const response = await fetch(base + '/portal/documents/' + secretUuid + '.pdf');
    assert.equal(response.status, 204);
  });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).route, 'PORTAL_PDF');
  assert.equal(lines[0].includes(secretUuid), false);
});

test('server-generated request ID is available to downstream handlers and cannot be caller-selected', async () => {
  const lines = [];
  await withServer({
    logger: line => lines.push(line),
    handler(request, response) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ requestId: request.requestId }));
    },
  }, async base => {
    const response = await fetch(base + '/integration/v1/capabilities', {
      headers: { 'X-Request-ID': 'caller-controlled' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), FIXED_ID);
    assert.deepEqual(await response.json(), { requestId: FIXED_ID });
  });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).requestId, FIXED_ID);
  assert.equal(lines[0].includes('caller-controlled'), false);
});

test('logger failure cannot change the HTTP response', async () => {
  await withServer({
    logger() { throw new Error('synthetic telemetry sink failure'); },
    handler(_request, response) {
      response.writeHead(201, { 'Content-Type': 'text/plain' });
      response.end('ok');
    },
  }, async base => {
    const response = await fetch(base + '/health');
    assert.equal(response.status, 201);
    assert.equal(await response.text(), 'ok');
    assert.equal(response.headers.get('x-request-id'), FIXED_ID);
  });
});

test('invalid generated request ID disables telemetry rather than trusting unsafe data', async () => {
  const lines = [];
  await withServer({
    logger: line => lines.push(line),
    idFactory: () => 'unsafe\nrequest-id',
  }, async base => {
    const response = await fetch(base + '/health', { headers: { 'X-Request-ID': 'caller-id' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-request-id'), null);
  });
  assert.deepEqual(lines, []);
});
