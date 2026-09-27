'use strict';

// Real Chromium exercises the actual editor, without clicking Save. Fictional loopback HTTP only.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { readFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { renderEditor } = require('../src/browser-workspace-editor');

const ID = '22222222-2222-4222-8222-222222222222';
const CSRF = 'D'.repeat(43);
const CLIENT = readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8');
const DRIVER = String.raw`
(async () => {
  const get = id => document.getElementById(id);
  const wait = async (predicate, description) => {
    for (let attempt = 0; attempt < 280; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timed out: ' + description);
  };
  const edit = (id, value) => {
    get(id).value = value;
    get(id).dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    await wait(() => !get('editing-fields').disabled && !get('save').disabled, 'editor ready');
    if (!get('preview').hidden) throw new Error('Unsaved preview was visible');
    edit('customer', 'Autosave fictional client');
    edit('email', 'autosave@example.test');
    edit('line-1-description', 'Synthetic service');
    edit('line-1-quantity', '2');
    edit('line-1-price', '12,50');
    if (!get('preview').hidden) throw new Error('Preview appeared before server confirmation');
    // Deliberately NEVER requestSubmit(), click Save, or call the write API from this driver.
    await wait(() => !get('preview').hidden && get('status').textContent.includes('Révision 1'), 'first automatic save');
    const link = new URL(get('preview').href);
    if (link.pathname + link.search !== '/internal/workspaces/22222222-2222-4222-8222-222222222222/preview?lang=fr') {
      throw new Error('Wrong server-saved preview link');
    }
    const first = await fetch('/internal/workspaces/22222222-2222-4222-8222-222222222222',
      { credentials: 'same-origin', cache: 'no-store' });
    if (first.status !== 200 || (await first.json()).revision !== 1) throw new Error('Autosaved revision not retrievable');
    edit('notes', 'Second autosaved revision');
    if (!get('preview').hidden) throw new Error('Outdated preview remained visible after new edit');
    await wait(() => !get('preview').hidden && get('status').textContent.includes('Révision 2'), 'second automatic save');
    const second = await fetch('/internal/workspaces/22222222-2222-4222-8222-222222222222',
      { credentials: 'same-origin', cache: 'no-store' });
    const row = await second.json();
    if (second.status !== 200 || row.revision !== 2 || row.content.notes !== 'Second autosaved revision' ||
        row.content.lines[0].unitPriceCents !== 1250) throw new Error('Revisioned autosave lost data');
    document.documentElement.dataset.autosave = 'passed';
  } catch (error) {
    document.documentElement.dataset.autosave = 'failed';
    document.documentElement.dataset.autosaveError = error.message;
  }
})();`;

function send(response, status, type, body) {
  response.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}
function chromeBinary() {
  for (const candidate of [process.env.CHROME_BIN, '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/opt/google/chrome/chrome'].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error('Chrome/Chromium required for autosave test: no silent skip');
}
async function runChrome(binary, url, profile) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=16000',
      '--dump-dom', '--user-data-dir=' + profile, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let finished = false;
    const timeout = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 45000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 262144) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-1500); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      finished = true; clearTimeout(timeout);
      if (code !== 0 || !/\bdata-autosave="passed"/.test(output)) {
        const htmlState = output.match(/<html\b[^>]*>/i)?.[0] || 'missing HTML state';
        return reject(new Error(`Chromium autosave failed (exit ${code}): ${htmlState}; ${errors.slice(-350)}`));
      }
      resolve();
    });
  });
}
async function main() {
  let stored = null;
  let writes = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      if (request.method === 'GET' && url.pathname === '/internal/editor' && url.search === '?lang=fr') {
        return send(response, 200, 'text/html; charset=utf-8',
          renderEditor('fr').replace('</head>', '<script src="/autosave-driver.js" defer></script></head>'));
      }
      if (request.method === 'GET' && url.pathname === '/internal/editor-client.js') {
        return send(response, 200, 'text/javascript; charset=utf-8', CLIENT);
      }
      if (request.method === 'GET' && url.pathname === '/autosave-driver.js') {
        return send(response, 200, 'text/javascript; charset=utf-8', DRIVER);
      }
      if (request.method === 'GET' && url.pathname === '/internal/workspaces/csrf') {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ csrfToken: CSRF }));
      }
      if (request.method === 'GET' && url.pathname === `/internal/workspaces/${ID}` && stored) {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(stored));
      }
      if (['POST', 'PUT'].includes(request.method) &&
          (url.pathname === '/internal/workspaces' || url.pathname === `/internal/workspaces/${ID}`)) {
        assert.equal(request.headers.origin, origin);
        assert.equal(request.headers['x-facturations-csrf'], CSRF);
        assert.match(request.headers['content-type'] || '', /^application\/json/);
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32768) throw new Error('Oversized synthetic body');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.method === 'POST') {
          assert.equal(stored, null, 'Only one creation allowed');
          assert.match(body.creationKey, /^[a-f0-9]{32}$/);
          assert.equal(body.content.customer.email, 'autosave@example.test');
          assert.equal(body.content.lines[0].unitPriceCents, 1250);
          stored = { id: ID, revision: 1, content: body.content, status: 'WORK_IN_PROGRESS',
            invoiceIssued: false, emailed: false };
        } else {
          assert.ok(stored, 'Update requires saved workspace');
          assert.equal(body.expectedRevision, stored.revision);
          stored = { ...stored, revision: stored.revision + 1, content: body.content };
        }
        writes++;
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(stored));
      }
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch {
      send(response, 422, 'text/plain; charset=utf-8', 'Synthetic fixture rejected');
    }
  });
  const profile = mkdtempSync(join(tmpdir(), 'facturations-chrome-autosave-'));
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await runChrome(chromeBinary(), `http://127.0.0.1:${server.address().port}/internal/editor?lang=fr`, profile);
    assert.equal(writes, 2, 'Browser must autosave exactly two revisions without clicking Save');
    assert.equal(stored.revision, 2);
    assert.equal(stored.content.notes, 'Second autosaved revision');
    console.log('PASS: real Chromium FR automatically created and revised a fictional draft after quiet periods.');
    console.log('Scope: synthetic local HTTP routes only, no real staff identity, HTTPS, PostgreSQL or external provider.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
