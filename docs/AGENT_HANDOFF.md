# Facturations — Relève entre agents

**Actualisé : 2026-10-14**. Pour éviter une référence circulaire, le dernier commit de **la branche en cours** doit toujours être relu depuis GitHub (`git rev-parse HEAD` ou API); le SHA ci-dessous est le dernier commit de **code vérifié de la session précédente**, pas une assertion sur la tête de cette PR documentaire.

## Dernière tâche terminée

Correction d'un lecteur de payload Stripe limité à 1 Mio, avec traitement des uploads interrompus et tests unitaires/HTTP. Travail poussé dans [PR #163](https://github.com/takatakca/Facturations/pull/163), SHA **`347564627b5e4755d9d3de95de6c730056e7ec4c`**. Ses **10 checks GitHub Actions** ont conclu `success`. La PR n'était **pas fusionnée**; revue de `takatakmtl` demandée.

## Travail applicatif supplémentaire poussé

[PR #165](https://github.com/takatakca/Facturations/pull/165), SHA `653c90cda1b8c102f5e0a57f37d17b767d900b10` : lecteur JSON de brouillon avec limites et traitement d'abandon, nouveaux tests; revue indépendante demandée. Vérifier les jobs GitHub Actions du SHA exact, encore en cours lors de la mise à jour.

## Tâche en cours

Installer les documents de relève `PROJECT_STATUS.md`, `TASK_QUEUE.md`, `AGENT_HANDOFF.md`, `DEPLOYMENT.md`, `DECISIONS.md` et un contrôle CI de leur présence/structure sur la branche `docs/agent-handoff-ci-20261014`. Cette étape ne modifie ni le comportement financier ni la base de données.

## Références et fichiers

- `main` constaté : `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3` (protégé).
- Code de #163 : `src/stripe-raw-body.js`, `src/stripe-payment-webhook-route.js`, `tests/stripe-webhook-body.test.js`, `docs/stripe-verified-payment-webhook.md`.
- Branche de relève : `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `scripts/check-project-docs.js`, `tests/project-docs.test.js`, `package.json`, `.github/workflows/ci.yml`.

## Vérifications réellement exécutées

- Lecture du dépôt, de `AGENTS.md`, des documents de release, des PR/issues et des workflows sur GitHub.
- Statuts `main` et PR vérifiés; #163 : 10/10 checks GitHub Actions réussis.
- Tentative de lecture détaillée de la protection de branche : API GitHub **403** (permission absente), mais branche marquée `protected=true`.
- Vérification CI de cette branche : lire les nouveaux runs et consigner le verdict; ne pas supposer `PASS` sans résultat.
- Aucune migration, requête à une base réelle, émission Wave, envoi email ou transaction Stripe n'a été exécuté.
- Le conteneur local ne peut pas cloner `github.com` (DNS indisponible); GitHub Actions reste la source d'exécution CI à vérifier.

## Blocages et autorisations manquantes

- #158, #159, #160, #162, #163 : revue/merge selon règles réelles de GitHub.
- Aucun staging HTTPS + PostgreSQL dédié confirmé. Kit Coolify seulement en PR #159; ne pas considérer le VPS comme connecté.
- Preuves réelles Wave, email, paiement, conformité fiscale, sauvegardes et signature hébergement manquantes.
- Aucune clé/secrète ni donnée de client ne doit figurer dans le dépôt. Les déploiements et opérations financières irréversibles exigent les décisions spécifiques prévues dans `AGENTS.md`.

## Statut de déploiement

**Non déployé / non validé** dans le périmètre consulté. Une CI verte n'est pas une preuve d'installation.

## Prochaine action exacte

1. Ouvrir la nouvelle PR de relève et attendre le résultat du job `npm run check:project-docs` et du `npm test` complet.
2. Corriger toute erreur CI de la branche, pousser un commit additionnel puis actualiser les preuves.
3. Demander une revue indépendante, et fusionner uniquement si les règles et les autorisations le permettent.
4. Lire aussi le verdict CI et la revue de #165; corriger en cas d'échec.
5. Ensuite reprendre la PR #158 (bug de login en navigateur), avant de valider l'installation isolée #159 et l'intégration #160.
