'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { verifyIntegrationBearer, IntegrationAuthError } = require('../src/integration-auth');
const { createServer } = require('../src/server');
const { StoreError } = require('../src/draft-store');

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
    authorization: 'Bearer ' + token(),
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
      draftsRead: true,
      draftDetailsRead: true,
      draftApprovalStatusRead: true,
      draftWorkflowRead: true,
      customersRead: true,
      approvalsRead: true,
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


test('integration drafts endpoint returns bounded paginated draft summaries only', async () => {
  const calls = { list: 0, options: null };
  const dashboardStore = {
    async listDrafts(options) {
      calls.list += 1;
      calls.options = options;
      return {
        status: 'DRAFTS_ONLY',
        page: options.page,
        pageSize: options.pageSize,
        drafts: [{
          id: '11111111-1111-4111-8111-111111111111',
          createdAt: '2026-09-27T20:00:00.000Z',
          customerName: 'Client Exemple',
          invoiceDate: '2026-09-27',
          dueDate: '2026-10-12',
          totalCents: '125050',
          currency: 'CAD',
          status: 'DRAFT',
        }],
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
    const unauthorized = await fetch(base + '/integration/v1/drafts');
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.list, 0);

    const response = await fetch(base + '/integration/v1/drafts?page=2&pageSize=10', {
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0010' }) },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.options, { page: 2, pageSize: 10, offset: 10 });
    assert.equal(calls.list, 1);
    const body = await response.json();
    assert.deepEqual(body.data, {
      status: 'DRAFTS_ONLY',
      page: 2,
      pageSize: 10,
      drafts: [{
        id: '11111111-1111-4111-8111-111111111111',
        customerName: 'Client Exemple',
        invoiceDate: '2026-09-27',
        dueDate: '2026-10-12',
        totalCents: '125050',
        currency: 'CAD',
        status: 'DRAFT',
      }],
    });
    assert.doesNotMatch(JSON.stringify(body), /createdAt|email|address|token|secret|notes/i);

    for (const path of [
      '/integration/v1/drafts?page=0',
      '/integration/v1/drafts?pageSize=51',
      '/integration/v1/drafts?page=1&page=2',
      '/integration/v1/drafts?businessId=other',
    ]) {
      const denied = await fetch(base + path, {
        headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-' + crypto.randomUUID() }) },
      });
      assert.equal(denied.status, 422);
    }
    assert.equal((await fetch(base + '/integration/v1/drafts', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-0011' }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration drafts endpoint fails closed on malformed or oversized store output', async () => {
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  for (const result of [
    null,
    { status: 'ISSUED', page: 1, pageSize: 20, drafts: [] },
    { status: 'DRAFTS_ONLY', page: 1, pageSize: 20, drafts: [{ id: 'x' }] },
    { status: 'DRAFTS_ONLY', page: 1, pageSize: 1, drafts: [
      { id: 'a', customerName: 'A', invoiceDate: '2026-09-27', dueDate: '2026-10-01',
        totalCents: '1', currency: 'CAD', status: 'DRAFT' },
      { id: 'b', customerName: 'B', invoiceDate: '2026-09-27', dueDate: '2026-10-01',
        totalCents: '2', currency: 'CAD', status: 'DRAFT' },
    ] },
  ]) {
    const server = createServer({
      config,
      dashboardStore: { async listDrafts() { return result; } },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/integration/v1/drafts', {
        headers: { Authorization: 'Bearer ' + liveToken({ jti: 'integration-live-jti-' + crypto.randomUUID() }) },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});


test('integration capabilities expose customer read only to OWNER identities', async () => {
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
    const response = await fetch(base + '/integration/v1/capabilities', {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-capabilities',
      }) },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.capabilities.customersRead, false);
    assert.equal(body.data.capabilities.draftDetailsRead, false);
    assert.equal(body.data.capabilities.draftApprovalStatusRead, false);
    assert.equal(body.data.capabilities.draftWorkflowRead, false);
    assert.equal(body.data.capabilities.draftsRead, true);
    assert.equal(body.data.capabilities.approvalsRead, false);
    assert.equal(body.data.capabilities.draftWrite, false);
  });
});

test('integration customers endpoint is OWNER-only and returns minimized customer summaries', async () => {
  const calls = { list: 0, options: null };
  const customerDirectory = {
    async listCustomers(options) {
      calls.list += 1;
      calls.options = options;
      return {
        status: 'CUSTOMERS_ONLY',
        page: options.page,
        pageSize: options.pageSize,
        hasMore: false,
        customers: [{
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Client Exemple',
          email: 'client@example.test',
          address: '123 Rue Exemple',
          createdAt: '2026-09-27T20:00:00.000Z',
        }],
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
  const server = createServer({ config, customerDirectory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const unauthorized = await fetch(base + '/integration/v1/customers');
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.list, 0);

    const staffDenied = await fetch(base + '/integration/v1/customers', {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-customers',
      }) },
    });
    assert.equal(staffDenied.status, 403);
    assert.deepEqual(await staffDenied.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.list, 0);

    const response = await fetch(base + '/integration/v1/customers?page=1&pageSize=10&q=Client', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-customers',
      }) },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.list, 1);
    assert.deepEqual(calls.options, {
      page: 1,
      pageSize: 10,
      offset: 0,
      search: '%Client%',
    });
    const body = await response.json();
    assert.deepEqual(body.data, {
      status: 'CUSTOMERS_ONLY',
      page: 1,
      pageSize: 10,
      hasMore: false,
      customers: [{
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Client Exemple',
        email: 'client@example.test',
      }],
    });
    assert.doesNotMatch(JSON.stringify(body), /address|createdAt/i);

    for (const path of [
      '/integration/v1/customers?page=0',
      '/integration/v1/customers?pageSize=51',
      '/integration/v1/customers?q=x',
      '/integration/v1/customers?q=' + encodeURIComponent('x'.repeat(81)),
      '/integration/v1/customers?businessId=other',
    ]) {
      const denied = await fetch(base + path, {
        headers: { Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-' + crypto.randomUUID(),
        }) },
      });
      assert.equal(denied.status, 422);
    }
    assert.equal((await fetch(base + '/integration/v1/customers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-customers-post',
      }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration customers endpoint fails closed on malformed directory output', async () => {
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  for (const result of [
    null,
    { status: 'DRAFTS_ONLY', page: 1, pageSize: 20, hasMore: false, customers: [] },
    { status: 'CUSTOMERS_ONLY', page: 1, pageSize: 20, hasMore: false, customers: [{ id: 'x' }] },
    { status: 'CUSTOMERS_ONLY', page: 1, pageSize: 1, hasMore: false, customers: [
      { id: 'a', name: 'A', email: 'a@example.test' },
      { id: 'b', name: 'B', email: 'b@example.test' },
    ] },
  ]) {
    const server = createServer({
      config,
      customerDirectory: { async listCustomers() { return result; } },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/integration/v1/customers', {
        headers: { Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-' + crypto.randomUUID(),
        }) },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});


test('integration draft detail is OWNER-only and recalculates the stored snapshot before returning it', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = { get: 0 };
  const draftStore = {
    async getDraft(requestedId) {
      calls.get += 1;
      assert.equal(requestedId, id);
      return {
        id,
        status: 'DRAFT',
        createdAt: '2026-09-27T20:00:00.000Z',
        preview: {
          status: 'DRAFT',
          persisted: true,
          waveSynced: false,
          emailed: false,
          currency: 'CAD',
          customer: {
            name: 'Client Exemple',
            email: 'client@example.test',
            address: '123 Rue Exemple',
          },
          invoiceDate: '2026-09-27',
          dueDate: '2026-10-12',
          notes: 'Travail approuvé pour préparation',
          lines: [{
            description: 'Nettoyage de hotte',
            quantity: 1,
            unitPriceCents: 85000,
            discountCents: 0,
            taxable: false,
            lineTotalCents: 85000,
          }],
          taxes: [],
          subtotalCents: 85000,
          taxableSubtotalCents: 0,
          taxTotalCents: 0,
          totalCents: 85000,
          calculation: 'stored value must not be trusted',
        },
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
  const server = createServer({ config, draftStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const staffDenied = await fetch(base + '/integration/v1/drafts/' + id, {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-draft-detail',
      }) },
    });
    assert.equal(staffDenied.status, 403);
    assert.deepEqual(await staffDenied.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.get, 0);

    const response = await fetch(base + '/integration/v1/drafts/' + id, {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-draft-detail',
      }) },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.get, 1);
    const body = await response.json();
    assert.equal(body.data.id, id);
    assert.equal(body.data.status, 'DRAFT');
    assert.equal(body.data.preview.status, 'PREVIEW_ONLY');
    assert.equal(body.data.preview.persisted, false);
    assert.equal(body.data.preview.waveSynced, false);
    assert.equal(body.data.preview.emailed, false);
    assert.equal(body.data.preview.totalCents, 85000);
    assert.equal(body.data.preview.customer.email, 'client@example.test');
    assert.equal(body.data.preview.calculation,
      'Independent taxes on taxable discounted subtotal; half-up per tax to nearest cent.');
    assert.doesNotMatch(JSON.stringify(body), /createdAt|request_hash|idempotency/i);

    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '?businessId=other', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-draft-detail-query',
      }) },
    })).status, 422);
    assert.equal((await fetch(base + '/integration/v1/drafts/' + id, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-draft-detail-post',
      }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration draft detail preserves store errors and rejects malformed stored snapshots', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };

  const notFound = createServer({
    config,
    draftStore: {
      async getDraft() {
        const error = new (require('../src/draft-store').StoreError)('DRAFT_NOT_FOUND', 404);
        throw error;
      },
    },
  });
  notFound.listen(0, '127.0.0.1');
  await once(notFound, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + notFound.address().port +
      '/integration/v1/drafts/' + id, {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-detail-not-found',
      }) },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'DRAFT_NOT_FOUND' });
  } finally {
    await new Promise(resolve => notFound.close(resolve));
  }

  for (const stored of [
    null,
    { id, status: 'ISSUED', preview: {} },
    { id, status: 'DRAFT', preview: null },
    { id, status: 'DRAFT', preview: { customer: {}, lines: 'bad', taxes: [] } },
  ]) {
    const server = createServer({
      config,
      draftStore: { async getDraft() { return stored; } },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port +
        '/integration/v1/drafts/' + id, {
        headers: { Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-' + crypto.randomUUID(),
        }) },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});


test('integration approvals endpoint is OWNER-only and exposes internal approval state without issuer identity', async () => {
  const calls = { list: 0, options: null };
  const approvalLedger = {
    async listApprovals(options) {
      calls.list += 1;
      calls.options = options;
      return {
        status: 'INTERNAL_APPROVALS_ONLY',
        currency: 'CAD',
        page: options.page,
        pageSize: options.pageSize,
        hasMore: false,
        approvals: [{
          id: '33333333-3333-4333-8333-333333333333',
          draftId: '11111111-1111-4111-8111-111111111111',
          approvedBy: '22222222-2222-4222-8222-222222222222',
          approvedAt: '2026-09-27T21:00:00.000Z',
          totalCents: '85000',
          status: 'APPROVED_INTERNAL_ONLY',
          issued: false,
          waveSynced: false,
          emailed: false,
          paid: false,
        }],
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
  const server = createServer({ config, approvalLedger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const unauthenticated = await fetch(base + '/integration/v1/approvals');
    assert.equal(unauthenticated.status, 401);
    assert.equal(calls.list, 0);

    const staffDenied = await fetch(base + '/integration/v1/approvals', {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-approvals',
      }) },
    });
    assert.equal(staffDenied.status, 403);
    assert.deepEqual(await staffDenied.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.list, 0);

    const response = await fetch(base + '/integration/v1/approvals?page=2&pageSize=10', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-approvals',
      }) },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.options, { page: 2, pageSize: 10, offset: 10 });
    assert.equal(calls.list, 1);

    const body = await response.json();
    assert.deepEqual(body.data, {
      status: 'INTERNAL_APPROVALS_ONLY',
      currency: 'CAD',
      page: 2,
      pageSize: 10,
      hasMore: false,
      approvals: [{
        id: '33333333-3333-4333-8333-333333333333',
        draftId: '11111111-1111-4111-8111-111111111111',
        approvedAt: '2026-09-27T21:00:00.000Z',
        totalCents: '85000',
        currency: 'CAD',
        status: 'APPROVED_INTERNAL_ONLY',
        issued: false,
        waveSynced: false,
        emailed: false,
        paid: false,
      }],
    });
    assert.doesNotMatch(JSON.stringify(body), /"approvedBy"|"email"|"token"|"secret"|wave_access/i);

    for (const path of [
      '/integration/v1/approvals?page=0',
      '/integration/v1/approvals?pageSize=51',
      '/integration/v1/approvals?page=1&page=2',
      '/integration/v1/approvals?businessId=other',
    ]) {
      const denied = await fetch(base + path, {
        headers: { Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-' + crypto.randomUUID(),
        }) },
      });
      assert.equal(denied.status, 422);
    }

    assert.equal((await fetch(base + '/integration/v1/approvals', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-approvals-post',
      }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration approvals endpoint fails closed on malformed or oversized ledger output', async () => {
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };

  for (const result of [
    null,
    { status: 'DRAFTS_ONLY', currency: 'CAD', page: 1, pageSize: 20, hasMore: false, approvals: [] },
    { status: 'INTERNAL_APPROVALS_ONLY', currency: 'USD', page: 1, pageSize: 20, hasMore: false, approvals: [] },
    { status: 'INTERNAL_APPROVALS_ONLY', currency: 'CAD', page: 1, pageSize: 20, hasMore: false,
      approvals: [{ id: 'x' }] },
    { status: 'INTERNAL_APPROVALS_ONLY', currency: 'CAD', page: 1, pageSize: 1, hasMore: false,
      approvals: [
        { id: 'a', draftId: 'd1', approvedAt: '2026-09-27T21:00:00.000Z', totalCents: '1',
          status: 'APPROVED_INTERNAL_ONLY', issued: false, waveSynced: false, emailed: false, paid: false },
        { id: 'b', draftId: 'd2', approvedAt: '2026-09-27T21:01:00.000Z', totalCents: '2',
          status: 'APPROVED_INTERNAL_ONLY', issued: false, waveSynced: false, emailed: false, paid: false },
      ] },
  ]) {
    const server = createServer({
      config,
      approvalLedger: { async listApprovals() { return result; } },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port +
        '/integration/v1/approvals', {
        headers: { Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-' + crypto.randomUUID(),
        }) },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'STORAGE_UNAVAILABLE' });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});


test('integration draft write stays hidden until the separate write gate is enabled', async () => {
  let calls = 0;
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: false,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  const draftStore = {
    async createDraft() {
      calls += 1;
      throw new Error('must not run');
    },
  };
  const server = createServer({ config, draftStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-write-disabled',
        }),
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-write-disabled-0001',
      },
      body: '{}',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
    assert.equal(calls, 0);

    const capabilities = await fetch(base + '/integration/v1/capabilities', {
      headers: {
        Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-write-disabled-capabilities',
        }),
      },
    });
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).data.capabilities.draftWrite, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration draft creation is OWNER-only, idempotent and persists only a DRAFT', async () => {
  const calls = { create: 0, payload: null, key: null };
  const draftStore = {
    async createDraft(payload, key) {
      calls.create += 1;
      calls.payload = payload;
      calls.key = key;
      return {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'DRAFT',
        createdAt: '2026-09-27T21:00:00.000Z',
        preview: {
          status: 'DRAFT',
          persisted: true,
          waveSynced: false,
          emailed: false,
          currency: 'CAD',
          customer: {
            name: 'Client Exemple',
            email: 'client@example.test',
            address: null,
          },
          invoiceDate: '2026-09-27',
          dueDate: '2026-10-12',
          notes: null,
          lines: [{
            description: 'Nettoyage de hotte',
            quantity: 1,
            unitPriceCents: 85000,
            discountCents: 0,
            taxable: false,
            lineTotalCents: 85000,
          }],
          taxes: [],
          subtotalCents: 85000,
          taxableSubtotalCents: 0,
          taxTotalCents: 0,
          totalCents: 85000,
          calculation: 'Independent taxes on taxable discounted subtotal; half-up per tax to nearest cent.',
        },
        waveSynced: false,
        emailed: false,
        internalSecret: 'must-not-leak',
      };
    },
  };
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  const server = createServer({ config, draftStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const payload = {
    currency: 'CAD',
    customer: {
      name: 'Client Exemple',
      email: 'client@example.test',
      address: null,
    },
    invoiceDate: '2026-09-27',
    dueDate: '2026-10-12',
    notes: null,
    lines: [{
      description: 'Nettoyage de hotte',
      quantity: 1,
      unitPriceCents: 85000,
      discountCents: 0,
      taxable: false,
    }],
    taxes: [],
  };

  try {
    const unauthenticated = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'integration-draft-0001' },
      body: JSON.stringify(payload),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(calls.create, 0);

    const staffDenied = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + liveToken({
          roles: ['STAFF'],
          jti: 'integration-live-jti-staff-draft-create',
        }),
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-draft-0001',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(staffDenied.status, 403);
    assert.deepEqual(await staffDenied.json(), { error: 'OWNER_REQUIRED' });
    assert.equal(calls.create, 0);

    const response = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-owner-draft-create',
        }),
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-draft-0001',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.create, 1);
    assert.equal(calls.key, 'integration-draft-0001');
    assert.deepEqual(calls.payload, payload);
    const body = await response.json();
    assert.equal(body.data.id, '33333333-3333-4333-8333-333333333333');
    assert.equal(body.data.status, 'DRAFT');
    assert.equal(body.data.preview.status, 'DRAFT');
    assert.equal(body.data.preview.persisted, true);
    assert.equal(body.data.preview.waveSynced, false);
    assert.equal(body.data.preview.emailed, false);
    assert.equal(body.data.preview.totalCents, 85000);
    assert.doesNotMatch(JSON.stringify(body), /internalSecret|createdAt/i);

    assert.equal((await fetch(base + '/integration/v1/drafts?businessId=other', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + liveToken({
          jti: 'integration-live-jti-owner-draft-create-query',
        }),
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-draft-0002',
      },
      body: JSON.stringify(payload),
    })).status, 422);
    assert.equal(calls.create, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration draft creation fails closed on media, body, idempotency and storage errors', async () => {
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: true,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  let calls = 0;
  const draftStore = {
    async createDraft(_payload, key) {
      calls += 1;
      if (key === 'integration-conflict-0001') {
        throw new StoreError('IDEMPOTENCY_CONFLICT', 409);
      }
      if (key === 'integration-invalid-key') {
        throw new StoreError('INVALID_IDEMPOTENCY_KEY', 422);
      }
      return { id: 'x', status: 'ISSUED', preview: {} };
    },
  };
  const server = createServer({ config, draftStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const bearer = 'Bearer ' + liveToken({ jti: 'integration-live-jti-draft-errors' });
  try {
    const media = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(media.status, 415);
    assert.equal(calls, 0);

    const malformed = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'INVALID_JSON' });
    assert.equal(calls, 0);

    const conflict = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: bearer,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-conflict-0001',
      },
      body: '{}',
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'IDEMPOTENCY_CONFLICT' });

    const invalidKey = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: bearer,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-invalid-key',
      },
      body: '{}',
    });
    assert.equal(invalidKey.status, 422);
    assert.deepEqual(await invalidKey.json(), { error: 'INVALID_IDEMPOTENCY_KEY' });

    const malformedStore = await fetch(base + '/integration/v1/drafts', {
      method: 'POST',
      headers: {
        Authorization: bearer,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'integration-malformed-store',
      },
      body: '{}',
    });
    assert.equal(malformedStore.status, 503);
    assert.deepEqual(await malformedStore.json(), { error: 'STORAGE_UNAVAILABLE' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('integration draft approval status is OWNER-only and read-only', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = { draft: 0, approval: 0 };
  const draftStore = {
    async getDraft(requestedId) {
      calls.draft += 1;
      assert.equal(requestedId, id);
      return { id, status: 'DRAFT', preview: { status: 'DRAFT' } };
    },
  };
  const approvalLedger = {
    async getApprovalByDraftId(requestedId) {
      calls.approval += 1;
      assert.equal(requestedId, id);
      return {
        id: '33333333-3333-4333-8333-333333333333',
        draftId: id,
        approvedAt: '2026-09-27T21:00:00.000Z',
        totalCents: '85000',
        status: 'APPROVED_INTERNAL_ONLY',
        issued: false, waveSynced: false, emailed: false, paid: false,
      };
    },
  };
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: false,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  const server = createServer({ config, draftStore, approvalLedger });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const denied = await fetch(base + '/integration/v1/drafts/' + id + '/approval', {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-approval-status',
      }) },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'OWNER_REQUIRED' });
    assert.deepEqual(calls, { draft: 0, approval: 0 });

    const response = await fetch(base + '/integration/v1/drafts/' + id + '/approval', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-approval-status',
      }) },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, {
      draftId: id,
      approved: true,
      status: 'APPROVED_INTERNAL_ONLY',
      approval: {
        id: '33333333-3333-4333-8333-333333333333',
        approvedAt: '2026-09-27T21:00:00.000Z',
        status: 'APPROVED_INTERNAL_ONLY',
      },
      issued: false,
      waveSynced: false,
      emailed: false,
      paid: false,
    });
    assert.deepEqual(calls, { draft: 1, approval: 1 });
    assert.doesNotMatch(JSON.stringify(body), /"approvedBy"|"email"|"address"|"totalCents"/i);

    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '/approval?x=1', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-approval-query',
      }) },
    })).status, 422);
    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '/approval', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-approval-post',
      }) },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration draft approval status returns explicit NOT_APPROVED without inventing approval', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: false,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  const server = createServer({
    config,
    draftStore: { async getDraft() { return { id, status: 'DRAFT', preview: {} }; } },
    approvalLedger: { async getApprovalByDraftId() { return null; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port +
      '/integration/v1/drafts/' + id + '/approval', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-not-approved',
      }) },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.approved, false);
    assert.equal(body.data.status, 'NOT_APPROVED');
    assert.equal(body.data.approval, null);
    assert.equal(body.data.issued, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('integration draft workflow tells OWNER the safe next step without enabling native financial actions', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: false,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  let approved = false;
  const calls = { draft: 0, approval: 0 };
  const server = createServer({
    config,
    draftStore: {
      async getDraft(requestedId) {
        calls.draft += 1;
        assert.equal(requestedId, id);
        return { id, status: 'DRAFT', preview: {} };
      },
    },
    approvalLedger: {
      async getApprovalByDraftId(requestedId) {
        calls.approval += 1;
        assert.equal(requestedId, id);
        return approved ? {
          id: '33333333-3333-4333-8333-333333333333',
          draftId: id,
          status: 'APPROVED_INTERNAL_ONLY',
        } : null;
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const denied = await fetch(base + '/integration/v1/drafts/' + id + '/workflow', {
      headers: { Authorization: 'Bearer ' + liveToken({
        roles: ['STAFF'],
        jti: 'integration-live-jti-staff-workflow',
      }) },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(calls, { draft: 0, approval: 0 });

    const before = await fetch(base + '/integration/v1/drafts/' + id + '/workflow', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-workflow-before',
      }) },
    });
    assert.equal(before.status, 200);
    assert.deepEqual((await before.json()).data, {
      draftId: id,
      status: 'DRAFT',
      internalApproval: 'NOT_APPROVED',
      nextStep: 'STANDALONE_OWNER_REVIEW',
      nativeActions: {
        approve: false,
        authorizeIssuance: false,
        issue: false,
        deliver: false,
        recordPayment: false,
      },
    });

    approved = true;
    const after = await fetch(base + '/integration/v1/drafts/' + id + '/workflow', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-owner-workflow-after',
      }) },
    });
    assert.equal(after.status, 200);
    assert.deepEqual((await after.json()).data, {
      draftId: id,
      status: 'DRAFT',
      internalApproval: 'APPROVED_INTERNAL_ONLY',
      nextStep: 'STANDALONE_ISSUANCE_AUTHORIZATION',
      nativeActions: {
        approve: false,
        authorizeIssuance: false,
        issue: false,
        deliver: false,
        recordPayment: false,
      },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('integration draft workflow rejects query/method and missing storage', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const config = {
    businessId: BUSINESS,
    adminKey: '',
    waveToken: '',
    integrationEnabled: true,
    integrationWritesEnabled: false,
    integrationIssuer: ISSUER,
    integrationAudience: AUDIENCE,
    integrationSecret: SECRET,
  };
  await withServer(config, async (base) => {
    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '/workflow', {
      headers: { Authorization: 'Bearer ' + liveToken({
        jti: 'integration-live-jti-workflow-storage',
      }) },
    })).status, 503);
  });

  const server = createServer({
    config,
    draftStore: { async getDraft() { return { id, status: 'DRAFT', preview: {} }; } },
    approvalLedger: { async getApprovalByDraftId() { return null; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const bearer = 'Bearer ' + liveToken({ jti: 'integration-live-jti-workflow-bounds' });
    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '/workflow?x=1', {
      headers: { Authorization: bearer },
    })).status, 422);
    assert.equal((await fetch(base + '/integration/v1/drafts/' + id + '/workflow', {
      method: 'POST',
      headers: { Authorization: bearer },
    })).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
