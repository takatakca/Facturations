'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkProjectDocs, REQUIRED } = require('../scripts/check-project-docs');

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facturations-handoff-'));
  try {
    for (const [filename, headings] of Object.entries(REQUIRED)) {
      const dest = path.join(root, filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, headings.join('\n') + '\n', 'utf8');
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('project handoff: required documents exist in the repository', () => {
  assert.deepEqual(checkProjectDocs(), []);
});

test('project handoff: complete document set passes without external dependencies', () => {
  withFixture(root => assert.deepEqual(checkProjectDocs(root), []));
});

test('project handoff: omitted file is rejected with only a repository-relative path', () => {
  withFixture(root => {
    fs.unlinkSync(path.join(root, 'docs/AGENT_HANDOFF.md'));
    const failures = checkProjectDocs(root);
    assert.ok(failures.some(error => error.includes('docs/AGENT_HANDOFF.md: missing')));
    assert.equal(failures.some(error => error.includes(root)), false);
  });
});

test('project handoff: missing required section is rejected', () => {
  withFixture(root => {
    const filename = path.join(root, 'docs/AGENT_HANDOFF.md');
    fs.writeFileSync(filename, '# Facturations\n## Tâche en cours\n', 'utf8');
    const failures = checkProjectDocs(root);
    assert.ok(failures.some(error => error.includes('Dernière tâche terminée')));
    assert.ok(failures.some(error => error.includes('Prochaine action exacte')));
  });
});

test('project handoff: rejects a document without final newline or containing NUL', () => {
  withFixture(root => {
    const filename = path.join(root, 'docs/DECISIONS.md');
    fs.appendFileSync(filename, 'unfinished');
    assert.ok(checkProjectDocs(root).some(error => error.includes('trailing newline')));
    fs.appendFileSync(filename, '\u0000\n');
    assert.ok(checkProjectDocs(root).some(error => error.includes('binary')));
  });
});

test('project handoff: malformed UTF-8 bytes are rejected rather than replaced', () => {
  withFixture(root => {
    const filename = path.join(root, 'docs/AGENT_HANDOFF.md');
    // 0xC3 without a continuation byte is invalid UTF-8, but fs.readFileSync
    // with the legacy utf8 option would silently replace it with U+FFFD.
    fs.appendFileSync(filename, Buffer.from([0xC3, 0x28, 0x0A]));
    const failures = checkProjectDocs(root);
    assert.ok(failures.includes('docs/AGENT_HANDOFF.md: invalid UTF-8'));
    assert.equal(failures.some(error => error.includes(root)), false);
  });
});

test('project handoff: valid multilingual UTF-8 content remains accepted', () => {
  withFixture(root => {
    const filename = path.join(root, 'docs/AGENT_HANDOFF.md');
    fs.appendFileSync(filename, 'Données privées — suivi technique, Español, 中文.\n', 'utf8');
    assert.deepEqual(checkProjectDocs(root), []);
  });
});
