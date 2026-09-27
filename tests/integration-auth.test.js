'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { verifyIntegrationBearer, IntegrationAuthError } = require('../src/integration-auth');
const { createServer } = require('../src/server');

const SECRET = 'integration-test-secret-abcdefghijklmnopqrstuvwxyz012345';
const ISSUER = 'https://identity.takatak.ca';
const AUDIENCE = 'facturations';
const BUSINESS = 'business-one';
const NOW = 1_800_000_000;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(overrides = {}, headerOverrides = {}) {
  const header = { alg: 'HS256', typ: 'JWT', ...headerOverrides };
  const payload = {
    version: 1,
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'master-user-123456',
    business_id: BUSINESS,
    roles: ['OWNER'],
    iat: NOW - 5,
    exp: NOW + 55,
    jti: 'integration-test-jti-0001',
    ...overrides,
  };
  const input = encode(header) + '.' + encode(payload);
  const signature = crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
  return input + '.' + signature;
}
function liveToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return token({ iat: now - 5, exp: now + 55, jti: 'integration-live-jti-0001', ...overrides });
}

test('signed short-lived integration token is accepted only for the configured tenant', () => {
  const principal = verifyIntegrationBearer({
    authorization: 'Bearer ' + liveToken(),
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    businessId: BUSINESS,
    nowMs: NOW * 1000,
  });
  assert.deepEqual(principal, {
    subject: 'master-user-123456',
    businessId: BUSINESS,
    roles: ['OWNER'],
    jti: 'integration-test-jti-0001',
    issuedAt: NOW - 5,
    expiresAt: NOW + 55,
  });
});

test('integration verifier rejects forgery, wrong tenant, issuer/audience, role and malformed claims', () => {
  const base = {
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    businessId: BUSINESS,
    nowMs: NOW * 1000,
  };
  for (const authorization of [
    undefined,
    'Bearer bad.token.value',
    'Basic abc',
    'Bearer ' + token({ business_id: 'other-business' }),
    'Bearer ' + token({ iss: 'https://evil.example' }),
    'Bearer ' + token({ aud: 'other-service' }),
    'Bearer ' + token({ roles: ['ADMIN'] }),
    'Bearer ' + token({ roles: ['OWNER', 'OWNER'] }),
    'Bearer ' + token({ sub: 'x' }),
    'Bearer ' + token({ jti: 'short' }),
    'Bearer ' + token({ extra: true }),
    'Bearer ' + token({}, { alg: 'none' }),
  ]) {
    assert.throws(() => verifyIntegrationBearer({ authorization, ...base }), IntegrationAuthError);
  }

  const valid = token();
  const parts = valid.split('.');
  const forged = parts[0] + '.' + parts[1] + '.' +
    crypto.randomBytes(32).toString('base64url');
  assert.throws(() => verifyIntegrationBearer({
    authorization: 'Bearer ' + forged, ...base,
  }), IntegrationAuthError);
});

test('integration verifier enforces short lifetime and clock bounds', () => {
  const base = {
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
    businessId: BUSINESS,
    nowMs: NOW * 1000,
  };
  for (const claims of [
    { iat: NOW - 200, exp: NOW + 1 },
    { iat: NOW + 20, exp: NOW + 30 },
    { iat: NOW - 10, exp: NOW - 20 },
    { iat: NOW, exp: NOW },
  ]) {
    assert.throws(
      () => verifyIntegrationBearer({ authorization: 'Bearer ' + token(claims), ...base }),
      (error) => error instanceof IntegrationAuthError &&
        error.code === 'EXPIRED_OR_INVALID_INTEGRATION_TOKEN',
    );
  }
});

async function withServer(config, run) {
  const server = createServer({ config });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('integration capabilities endpoint is hidden when disabled', async () => {
  await withServer({
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: false,
  }, async (base) => {
    const response = await fetch(base + '/integration/v1/capabilities');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
  });
});

test('integration capabilities endpoint requires valid service identity and exposes no financial data', async () => {
  await withServer({
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  }, async (base) => {
    const unauthorized = await fetch(base + '/integration/v1/capabilities');
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'INTEGRATION_AUTH_REQUIRED' });

    assert.equal((await fetch(base + '/integration/v1/capabilities?x=1', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 422);
    assert.equal((await fetch(base + '/integration/v1/capabilities', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken() },
    })).status, 405);

    const response = await fetch(base + '/integration/v1/capabilities', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.version, 1);
    assert.equal(body.businessId, BUSINESS);
    assert.equal(body.data.service, 'facturations');
    assert.equal(body.data.integrationVersion, 1);
    assert.deepEqual(body.data.capabilities, {
      capabilitiesRead: true,
      dashboardRead: true,
      draftsRead: false,
      customersRead: false,
      draftWrite: false,
      ownerApprovalWrite: false,
      issuanceAuthorizationWrite: false,
      deliveryAuthorizationWrite: false,
      portalPublicationWrite: false,
    });
    assert.deepEqual(body.data.standalone, {
      staffWorkspace: true,
      clientPortal: true,
      bilingual: ['fr', 'en'],
    });
    assert.doesNotMatch(JSON.stringify(body), /email|token|secret|wave|payment|amount/i);
  });
});


test('integration dashboard endpoint returns only tenant-scoped draft summary', async () => {
  const calls = { summary: 0 };
  const dashboardStore = {
    async getSummary() {
      calls.summary += 1;
      return {
        status: 'DRAFTS_ONLY',
        currency: 'CAD',
        draftCount: '3',
        draftTotalCents: '125050',
        customerCount: '2',
        issuedInvoicesAvailable: false,
        paymentsAvailable: false,
        revenueAvailable: false,
      };
    },
  };
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  const server = createServer({ config, dashboardStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const unauthorized = await fetch(base + '/integration/v1/dashboard');
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.summary, 0);

    const response = await fetch(base + '/integration/v1/dashboard', {
      headers: { Authorization: 'Bearer ' + liveToken() },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(calls.summary, 1);
    assert.deepEqual(body.data, {
      status: 'DRAFTS_ONLY',
      currency: 'CAD',
      draftCount: '3',
      draftTotalCents: '125050',
      customerCount: '2',
      issuedInvoicesAvailable: false,
      paymentsAvailable: false,
      revenueAvailable: false,
    });
    assert.doesNotMatch(JSON.stringify(body), /email|address|token|secret/i);

    assert.equal((await fetch(base + '/integration/v1/dashboard?x=1', {
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0002' }) },
    })).status, 422);
    assert.equal((await fetch(base + '/integration/v1/dashboard', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0003' }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration dashboard fails closed on missing or invalid summary storage', async () => {
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  await withServer(config, async (base) => {
    const response = await fetch(base + '/integration/v1/dashboard', {
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0004' }) },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'STORAGE_NOT_CONFIGURED' });
  });

  const server = createServer({
    config,
    dashboardStore: { async getSummary() { return { status: 'ISSUED' }; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/integration/v1/dashboard', {
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0005' }) },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
