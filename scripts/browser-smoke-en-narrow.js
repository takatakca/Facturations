'use strict';

// English narrow-viewport companion to browser-smoke.js. Disposable localhost fixtures only.
// This is NOT mobile device emulation, HTTPS, MFA, production database or a deployment test.
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
    for (let n = 0; n < 240; n++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out: ' + label);
  };
  try {
    if (document.documentElement.lang !== 'en') throw new Error('Wrong editor language');
    const width = window.innerWidth;
    if (width < 400 || width > 620) throw new Error('Not a narrow CSS viewport: ' + width);
    if (document.documentElement.scrollWidth > width + 2) throw new Error('Horizontal document overflow');
    const columns = getComputedStyle(document.querySelector('.three')).gridTemplateColumns.trim().split(/\s+/);
    if (columns.length !== 1) throw new Error('Tax inputs are not stacked on the narrow viewport');
    await wait(() => !get('editing-fields').disabled && !get('save').disabled, 'English editor unlocked');
    if (!get('preview').hidden) throw new Error('Preview visible before saving');
    const fill = (id, value) => {
      const control = get(id);
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('customer', 'Fictional customer');
    fill('email', 'fictional@example.test');
    fill('invoiceDate', '2026-09-21');
    fill('dueDate', '2026-10-21');
    fill('line-1-description', 'Fictional service');
    fill('line-1-quantity', '2');
    fill('line-1-price', '12.50');
    get('line-1-taxable').checked = true;
    get('line-1-taxable').dispatchEvent(new Event('change', { bubbles: true }));
    fill('tax-1-code', 'TEST');
    fill('tax-1-label', 'Fictional tax');
    fill('tax-1-rate', '9.975');
    get('editor').requestSubmit();
    await wait(() => !get('preview').hidden, 'confirmed English save');
    const preview = get('preview');
    const link = new URL(preview.href);
    if (link.pathname + link.search !== '/internal/workspaces/22222222-2222-4222-8222-222222222222/preview?lang=en') {
      throw new Error('Wrong English preview URL');
    }
    const response = await fetch(preview.href, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status !== 200) throw new Error('English preview HTTP ' + response.status);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.documentElement.lang !== 'en' || !doc.body.textContent.includes('Fictional customer') ||
        !doc.body.textContent.includes('PREVIEW ONLY') || !doc.body.textContent.includes('27.49')) {
      throw new Error('English server preview or calculated CAD total missing');
    }
    fill('notes', 'Unsaved change');
    if (!preview.hidden || getComputedStyle(preview).display !== 'none') {
      throw new Error('Stale English preview remains visible');
    }
    if (document.documentElement.scrollWidth > window.innerWidth + 2) {
      throw new Error('Horizontal overflow after editing');
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
function chromeBinary() {
  const options = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome'].filter(Boolean);
  for (const option of options) if (existsSync(option)) return option;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium required: never skip narrow English browser checks');
}
function runChrome(binary, url, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run',
      '--no-default-browser-check', '--window-size=500,850', '--force-device-scale-factor=1',
      '--virtual-time-budget=12000', '--dump-dom', '--user-data-dir=' + profile, url],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const timeout = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 45000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 262144) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      closed = true;
      clearTimeout(timeout);
      if (code !== 0 || !/\bdata-smoke="passed"/.test(stdout)) {
        const state = stdout.match(/<html\b[^>]*>/i)?.[0] || 'missing html state';
        return reject(new Error(`English narrow browser smoke failed (exit ${code}): ${state}; ${stderr.slice(-500)}`));
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
      if (request.method === 'GET' && url.pathname === '/internal/editor' && url.search === '?lang=en') {
        const html = renderEditor('en').replace('</head>', '<script src="/smoke-driver.js" defer></script></head>');
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
        assert.equal(body.content.customer.email, 'fictional@example.test');
        assert.equal(body.content.lines[0].unitPriceCents, 1250);
        assert.equal(body.content.taxes[0].rateMilliPercent, 9975);
        assert.equal(previewDraft(body.content).totalCents, 2749);
        saved = { id: ID, revision: 1, content: body.content,
          status: 'WORK_IN_PROGRESS', invoiceIssued: false, emailed: false };
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(saved));
      }
      if (request.method === 'GET' && url.pathname === `/internal/workspaces/${ID}/preview` &&
          url.search === '?lang=en' && saved) {
        previews++;
        return send(response, 200, 'text/html; charset=utf-8',
          renderWorkspacePreview({ preview: previewDraft(saved.content), id: ID,
            revision: saved.revision, language: 'en' }));
      }
      return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch {
      // Local synthetic fixture only; never log request content.
      return send(response, 422, 'text/plain; charset=utf-8', 'Synthetic fixture rejected');
    }
  });
  const profile = mkdtempSync(join(tmpdir(), 'facturations-chromium-en-'));
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await runChrome(chromeBinary(), `http://127.0.0.1:${server.address().port}/internal/editor?lang=en`, profile);
    assert.ok(saved, 'English narrow screen must save fictional workspace');
    assert.equal(previews, 1, 'English narrow screen must fetch calculated preview once');
    console.log('PASS: Chromium EN narrow CSS viewport → synthetic save → server preview 27.49 CAD → unsaved link hidden');
    console.log('Scope: synthetic localhost; narrow viewport is not device emulation, TLS, MFA or production.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
