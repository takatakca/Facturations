'use strict';

// Keep repository handoff instructions present and machine-checkable.
// No network access, secrets, timestamps or mutable deployment state.
const fs = require('node:fs');
const path = require('node:path');

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
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > 65_536) {
        failures.push(relative + ': expected UTF-8 Markdown file up to 64 KiB');
        continue;
      }
      content = fs.readFileSync(filename, 'utf8');
    } catch {
      failures.push(relative + ': missing or unreadable');
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
