'use strict';

// Keep repository handoff instructions present and machine-checkable.
// No network access, secrets, timestamps or mutable deployment state.
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const REQUIRED = Object.freeze({
  'docs/PROJECT_STATUS.md': ['# Facturations', '## Références Git', '## État opérationnel'],
  'docs/TASK_QUEUE.md': ['# Facturations', '## Règles d\'exécution'],
  'docs/AGENT_HANDOFF.md': [
    '# Facturations',
    '## Dernière tâche terminée',
    '## Tâche en cours',
    '## Références et fichiers',
    '## Vérifications réellement exécutées',
    '## Blocages et autorisations manquantes',
    '## Statut de déploiement',
    '## Prochaine action exacte',
  ],
  'docs/DEPLOYMENT.md': ['# Facturations', '## Hébergement cible', '## Pipeline existant', '## Publication et rollback'],
  'docs/DECISIONS.md': ['# Facturations', '## À ne pas considérer comme décidé'],
});

function checkProjectDocs(root = path.resolve(__dirname, '..')) {
  const failures = [];
  for (const [relative, headings] of Object.entries(REQUIRED)) {
    const filename = path.join(root, relative);
    let content;
    try {
      // Follow neither a symlinked docs directory nor a symlinked document:
      // an untrusted checkout must not make CI read files outside this repo.
      const directory = fs.lstatSync(path.dirname(filename));
      const stat = fs.lstatSync(filename);
      if (!directory.isDirectory() || stat.isSymbolicLink()) {
        failures.push(relative + ': symbolic links and non-regular paths are not allowed');
        continue;
      }
      if (!stat.isFile() || stat.size > 65_536) {
        failures.push(relative + ': expected UTF-8 Markdown file up to 64 KiB');
        continue;
      }
      // A regular UTF-8 read silently substitutes malformed bytes with U+FFFD.
      // Fail closed so the handoff cannot be corrupted while CI still passes.
      content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename));
    } catch (error) {
      failures.push(relative + (error instanceof TypeError ? ': invalid UTF-8' : ': missing or unreadable'));
      continue;
    }
    if (!content.trim() || content.includes('\u0000') || !content.endsWith('\n')) {
      failures.push(relative + ': empty, binary or missing trailing newline');
    }
    const lines = content.split(/\r?\n/u);
    for (const heading of headings) {
      if (!lines.some(line => line === heading || line.startsWith(heading + ' '))) {
        failures.push(relative + ': missing heading ' + heading);
      }
    }
  }
  return failures;
}

if (require.main === module) {
  const failures = checkProjectDocs();
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log('Project status and agent handoff documentation: PASS');
  }
}

module.exports = { checkProjectDocs, REQUIRED };
