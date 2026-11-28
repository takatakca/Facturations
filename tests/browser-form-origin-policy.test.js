'use strict';

// Regression guard: real browser form submissions must carry a usable Origin.
// Under `Referrer-Policy: no-referrer`, Chromium serializes the Origin header
// of a same-origin form POST as the literal "null" (Fetch "append a request
// Origin header"), so every same-origin CSRF/Origin check rejects the real
// login form. `same-origin` keeps referrers away from other sites while the
// browser still sends the exact origin to Facturations itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

test('no Facturations response uses Referrer-Policy no-referrer (breaks real form POST Origin)', () => {
  for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.equal(/no-referrer/u.test(source), false, `${file} must not send Referrer-Policy: no-referrer`);
  }
});

test('the staff login page itself advertises same-origin', () => {
  const source = fs.readFileSync(path.join(SRC, 'browser-staff-login.js'), 'utf8');
  assert.match(source, /'Referrer-Policy': 'same-origin'/u);
  const edge = fs.readFileSync(path.join(SRC, 'production-edge-guard.js'), 'utf8');
  assert.match(edge, /'Referrer-Policy','same-origin'/u);
});
