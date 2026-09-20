'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../src/server');

const adminKey = 'k'.repeat(64);
const example = {
  currency: 'CAD',
  customer: { name: 'Café Démo', email: 'demo@example.test' },
  invoiceDate: '2026-09-20', dueDate: '2026-10-20',
  notes: 'Service de réparation',
  lines: [{ description: 'Service', quantity: 1, unitPriceCents: 1000, taxable: false }],
  taxes: [],
};

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, payload: await response.json() };
}

test('draft JSON HTTP endpoints reject malformed UTF-8 before preview or persistence', async () => {
  let stored = 0;
  const draftStore = {
    async createDraft(payload) {
      stored++;
      return { status: 'DRAFT', preview: payload };
    },
  };
  const server = createServer({ config: { adminKey }, draftStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const valid = Buffer.from(JSON.stringify(example), 'utf8');
    const accent = valid.indexOf(Buffer.from('é', 'utf8'));
    assert.notEqual(accent, -1);
    const invalidContinuation = Buffer.from(valid);
    invalidContinuation[accent + 1] = 0x28;
    const truncatedSequence = Buffer.from(valid);
    truncatedSequence[accent + 1] = 0x20;

    for (const path of ['/api/drafts/preview', '/api/drafts']) {
      for (const body of [invalidContinuation, truncatedSequence]) {
        const result = await post(base, path, body);
        assert.equal(result.status, 400, `malformed UTF-8 at ${path}`);
        assert.deepEqual(result.payload, { error: 'INVALID_JSON' });
      }
    }
    assert.equal(stored, 0, 'rejected bytes must not reach draft persistence');

    const preview = await post(base, '/api/drafts/preview', valid);
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.customer.name, 'Café Démo');
    const saved = await post(base, '/api/drafts', valid);
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.preview.customer.name, 'Café Démo');
    assert.equal(stored, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
