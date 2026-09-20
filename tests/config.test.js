'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('defaults to port 3000 and keeps credentials absent', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, adminKey: '', waveToken: '' });
});

test('accepts port 0 for temporary test server and trims token', () => {
  const key = 'x'.repeat(32);
  assert.deepEqual(loadConfig({ PORT: '0', TAKATAK_ADMIN_KEY: key, WAVE_ACCESS_TOKEN: ' abc ' }), {
    port: 0, adminKey: key, waveToken: 'abc',
  });
});

test('rejects invalid ports and weak admin keys', () => {
  for (const port of ['-1', 'abc', '65536', '3.5', ' 3']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ TAKATAK_ADMIN_KEY: 'short' }), /TAKATAK_ADMIN_KEY/);
});
