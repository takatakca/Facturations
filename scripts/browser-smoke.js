'use strict';

// Real Chromium UI smoke with a disposable, synthetic HTTP origin.
// Not a test of production authentication, HTTPS, staff cookies or a deployed host.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { readFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { renderEditor } = require('../src/browser-workspace-editor');
const { previewDraft } = require('../src/draft-preview');
const { renderWorkspacePreview } = require('../src/browser-workspace-preview');

const ID = '22222222-2222-4222-8222-222222222222';
const CSRF = 'D'.repeat(43);
const CLIENT = readFileSync(join(__dirname, '../src/workspace-editor-client.js'), 'utf8');
const DRIVER = String.raw`
(async () => {
  const get = id => document.getElementById(id);
  const wait = async (predicate, label) => {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out: ' + label);
  };
  try {
    await wait(() => !get('editing-fields').disabled && !get('save').disabled, 'editor unlocked');
    if (!get('preview').hidden) throw new Error('Unsaved preview appeared');
    const fill = (id, value) => {
      const input = get(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('customer', 'Client fictif');
    fill('email', 'client@example.test');
    fill('invoiceDate', '2026-09-21');
    fill('dueDate', '2026-10-21');
    fill('line-1-description', 'Service fictif');
    fill('line-1-quantity', '2');
    fill('line-1-price', '12,50');
    if (!get('preview').hidden) throw new Error('Preview visible before save');
    get('editor').requestSubmit();
    await wait(() => !get('preview').hidden, 'confirmed save and preview link');
    const preview = get('preview');
    const link = new URL(preview.href);
    if (link.pathname + link.search !== '/internal/workspaces/22222222-2222-4222-8222-222222222222/preview?lang=fr') {
      throw new Error('Unexpected preview URL');
    }
    const response = await fetch(preview.href, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status !== 200) throw new Error('Preview HTTP ' + response.status);
    const html = await response.text();
    const rendered = new DOMParser().parseFromString(html, 'text/html');
    if (!rendered.body.textContent.includes('Client fictif') ||
        !rendered.body.textContent.includes('APERÇU SEULEMENT')) {
      throw new Error('Server-calculated preview content missing');
    }
    fill('notes', 'Modification non enregistrée');
    // PR #46 hides the link for unsaved changes; it does not promise removal of href.
    if (!preview.hidden || getComputedStyle(preview).display !== 'none') {
      throw new Error('Stale preview remains visible after edit');
    }
    document.documentElement.dataset.smoke = 'passed';
  } catch (error) {
    document.documentElement.dataset.smoke = 'failed';
    document.documentElement.dataset.smokeError = error.message;
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
function browserBinary() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome'].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chromium/Chrome is required for the real browser smoke; no silent skip');
}
function runBrowser(binary, url, profileDir) {
  return new Promise((resolve, reject) => {
    const args = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-extensions', '--disable-background-networking', '--no-first-run',
      '--no-default-browser-check', '--virtual-time-budget=12000', '--dump-dom',
      '--user-data-dir=' + profileDir, url];
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ended = false;
    const timeout = setTimeout(() => {
      if (!ended) child.kill('SIGKILL');
    }, 45000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 262144) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      ended = true;
      clearTimeout(timeout);
      if (code !== 0 || !/\bdata-smoke="passed"/.test(stdout)) {
        const documentState = stdout.match(/<html\b[^>]*>/i)?.[0] || 'missing html state';
        return reject(new Error(`Browser smoke failed (exit ${code}): ${documentState}; ${stderr.slice(-500)}`));
      }
      resolve();
    });
  });
}

async function main() {
  let saved = null;
  let previews = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      if (request.method === 'GET' && url.pathname === '/internal/editor' && url.search === '?lang=fr') {
        const html = renderEditor('fr').replace('</head>', '<script src="/smoke-driver.js" defer></script></head>');
        return send(response, 200, 'text/html; charset=utf-8', html);
      }
      if (request.method === 'GET' && url.pathname === '/internal/editor-client.js') {
        return send(response, 200, 'text/javascript; charset=utf-8', CLIENT);
      }
      if (request.method === 'GET' && url.pathname === '/smoke-driver.js') {
        return send(response, 200, 'text/javascript; charset=utf-8', DRIVER);
      }
      if (request.method === 'GET' && url.pathname === '/internal/workspaces/csrf') {
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ csrfToken: CSRF }));
      }
      if (request.method === 'POST' && url.pathname === '/internal/workspaces') {
        assert.equal(request.headers.origin, origin);
        assert.equal(request.headers['x-facturations-csrf'], CSRF);
        assert.match(request.headers['content-type'] || '', /^application\/json/);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 32768) throw new Error('Oversized synthetic request');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.match(body.creationKey, /^[a-f0-9]{32}$/);
        assert.equal(body.content.customer.email, 'client@example.test');
        assert.equal(body.content.lines[0].unitPriceCents, 1250);
        assert.equal(previewDraft(body.content).totalCents, 2500);
        saved = { id: ID, revision: 1, content: body.content, status: 'WORK_IN_PROGRESS',
          invoiceIssued: false, emailed: false };
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(saved));
      }
      if (request.method === 'GET' && url.pathname === `/internal/workspaces/${ID}/preview` &&
          url.search === '?lang=fr' && saved) {
        previews++;
        const html = renderWorkspacePreview({ preview: previewDraft(saved.content), id: ID,
          revision: saved.revision, language: 'fr' });
        return send(response, 200, 'text/html; charset=utf-8', html);
      }
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch {
      // Synthetic test service: no source data or request payload is logged.
      send(response, 422, 'text/plain; charset=utf-8', 'Synthetic fixture rejected');
    }
  });
  const profileDir = mkdtempSync(join(tmpdir(), 'facturations-chromium-'));
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/internal/editor?lang=fr`;
    await runBrowser(browserBinary(), url, profileDir);
    assert.ok(saved, 'Browser must save one fictional workspace');
    assert.equal(previews, 1, 'Browser must open exactly one private-preview fixture');
    console.log('PASS: Chromium FR editor → synthetic save → server-calculated preview → unsaved-link hidden');
    console.log('Scope: local synthetic HTTP only; no real auth, HTTPS, database, client or provider.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
