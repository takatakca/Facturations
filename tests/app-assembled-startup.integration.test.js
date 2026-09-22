'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const crypto = require('node:crypto');

const DATABASE = process.env.FACTURATIONS_TEST_DATABASE_URL;
const UUID = '11111111-1111-4111-8111-111111111111';

test('assembled app boots with dedicated disposable PostgreSQL settings and denies anonymous private routes',
  { skip: !DATABASE, timeout: 20000 }, async () => {
    const target = new URL(DATABASE);
    assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only localhost test PostgreSQL');
    assert.equal(target.pathname, '/facturations_test');
    assert.equal(process.env.FACTURATIONS_DATABASE_URL, undefined, 'Never share application database with tests');

    // Deliberately do not inherit the caller's environment: no production Wave,
    // administrative key, customer information or deployed host can reach this child.
    const child = spawn(process.execPath, ['app.js'], {
      cwd: join(__dirname, '..'),
      env: {
        PORT: '0',
        FACTURATIONS_DATABASE_URL: DATABASE,
        WAVE_BUSINESS_ID: 'startup-' + crypto.randomUUID(),
        FACTURATIONS_PUBLIC_ORIGIN: 'https://facturations.example.test',
        FACTURATIONS_TOTP_ENCRYPTION_KEY: 'a'.repeat(64), // Synthetic CI key only.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      const port = await new Promise((resolve, reject) => {
        let finished = false;
        let output = '';
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Assembled application did not start')), 9000);
        child.on('error', () => finish(new Error('Cannot start isolated application process')));
        child.on('exit', code => finish(new Error('Assembled application exited before listening: ' + code)));
        child.stdout.on('data', chunk => {
          output = (output + chunk.toString('utf8')).slice(-2048);
          const match = /TAKATAK Wave development service listening on port (\d+)/.exec(output);
          if (match) finish(null, Number(match[1]));
        });
        // Avoid echoing stdout/stderr: startup diagnostics might contain sensitive data.
        child.stderr.resume();
      });
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      const get = path => fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: 'manual', signal: AbortSignal.timeout(5000),
      });
      const health = await get('/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await health.json()).ok, true);
      for (const language of ['fr', 'en']) {
        const login = await get('/internal/login?lang=' + language);
        assert.equal(login.status, 200);
        assert.match(await login.text(), /name="password"/);
      }
      for (const path of [
        '/internal/dashboard?lang=fr',
        '/internal/editor?lang=fr',
        `/internal/editor?lang=fr&id=${UUID}`,
        '/internal/recent-workspaces?lang=fr',
        '/internal/customers?lang=fr',
        '/internal/workspaces/csrf',
        `/internal/workspaces/${UUID}/preview?lang=fr`,
        `/internal/submit/${UUID}?lang=fr`,
        '/internal/review?lang=fr',
        `/internal/review/${UUID}?lang=fr`,
        `/internal/review/${UUID}/print?lang=fr`,
      ]) {
        const response = await get(path);
        assert.equal(response.status, 401, `Anonymous route must deny access: ${path}`);
        assert.equal(response.headers.get('set-cookie'), null);
      }
      const wave = await get('/api/wave/businesses');
      assert.equal(wave.status, 503, 'Unconfigured Wave fails closed without an upstream request');
      assert.equal(wave.headers.get('set-cookie'), null);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2500);
      try { await closed; } finally { clearTimeout(killTimer); }
    }
  });
