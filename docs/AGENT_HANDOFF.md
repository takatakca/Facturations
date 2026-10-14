# Facturations — Relève entre agents

**Actualisé : 2026-10-14**. Pour éviter une référence circulaire, le dernier commit de **la branche en cours** doit toujours être relu depuis GitHub (`git rev-parse HEAD` ou API); le SHA ci-dessous est le dernier commit de **code vérifié de la session précédente**, pas une assertion sur la tête de cette PR documentaire.

## Dernière tâche terminée

Correction d'un lecteur de payload Stripe limité à 1 Mio, avec traitement des uploads interrompus et tests unitaires/HTTP. Travail poussé dans [PR #163](https://github.com/takatakca/Facturations/pull/163), SHA **`347564627b5e4755d9d3de95de6c730056e7ec4c`**. Ses **10 checks GitHub Actions** ont conclu `success`. La PR n'était **pas fusionnée**; revue de `takatakmtl` demandée.

## Travail applicatif supplémentaire poussé

[PR #165](https://github.com/takatakca/Facturations/pull/165), SHA `653c90cda1b8c102f5e0a57f37d17b767d900b10` : lecteur JSON de brouillon avec limites et traitement d'abandon, nouveaux tests; revue indépendante demandée. Vérifier les jobs GitHub Actions du SHA exact, encore en cours lors de la mise à jour.

## Tâche en cours

Finaliser le correctif de validation UTF-8 des documents de relève sur `fix/project-docs-strict-utf8-20261014`, [PR #166](https://github.com/takatakca/Facturations/pull/166) empilée sur [PR #164](https://github.com/takatakca/Facturations/pull/164). La lecture du handoff avec `TextDecoder('utf-8', { fatal: true })` bloque désormais les octets invalides au lieu de les remplacer silencieusement. Le test de régression couvre aussi des caractères FR, ES et chinois valides. Le contrôle rejette désormais les fichiers et répertoires `docs` symboliquement liés, empêchant CI de suivre des chemins extérieurs au checkout.

**Dernier commit technique poussé dans cette branche à la présente mise à jour :** `6e02f7ba3582bd607814902dd931fb6f02b3d416` (tests contre les symlinks); correctif symlink `24f32e95e346e47bc973f468d5e57184a503ba4f`; tests UTF-8 `d7ef397a798e65222f38fba185f869f1925ea3d2`; commit initial du fix `f39cfaf5a2a4f8a1fc7832b3943c2d0572397a78`. Après toute modification de ce document, lire le nouveau SHA HEAD GitHub; une annotation du SHA dans un commit qu'elle modifie ne peut pas être autoréférentielle.

## Références et fichiers

- `main` constaté : `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3` (protégé).
- Code de #163 : `src/stripe-raw-body.js`, `src/stripe-payment-webhook-route.js`, `tests/stripe-webhook-body.test.js`, `docs/stripe-verified-payment-webhook.md`.
- Correctif UTF-8 de #166 : `scripts/check-project-docs.js`, `tests/project-docs.test.js`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`.
- Branche de relève (#164) : `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `scripts/check-project-docs.js`, `tests/project-docs.test.js`, `package.json`, `.github/workflows/ci.yml`.

## Vérifications réellement exécutées

- CI du commit initial `f39cfaf5a2a4f8a1fc7832b3943c2d0572397a78` : cinq jobs GitHub Actions terminés avec conclusion `success` (Node 20/22, Chromium, MFA/PostgreSQL, least privilege).
- CI de `docs/agent-handoff-ci-20261014` au SHA `2ee146883e5bb301d3a30c6cf24dd6cdce9e2c6e` : les jobs consultés sont `success`.
- Correctifs `d7ef397a798e65222f38fba185f869f1925ea3d2` et `6e02f7ba3582bd607814902dd931fb6f02b3d416` : tests UTF-8 et symlinks; résultats GitHub Actions à examiner sur le **HEAD final**, pas sur un ancien SHA.
- Tentative `git ls-remote https://github.com/takatakca/Facturations.git HEAD` dans le conteneur local : échec DNS `Could not resolve host: github.com` ; ne pas prétendre avoir exécuté les tests complets localement.
- PR #165 au SHA `653c90cda1b8c102f5e0a57f37d17b767d900b10` : 10/10 checks GitHub Actions `success`.

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

1. Vérifier les GitHub Actions du HEAD courant de la PR #166, incluant `npm run check:project-docs`, `npm run check` et `npm test`; corriger les erreurs avec un nouveau SHA.
2. Obtenir une revue indépendante de #164 puis la fusion autorisée sur `main`; retargeter ensuite #166 vers `main` et réexécuter les vérifications exactes.
3. Lire les PR #158 (login réel), #159 (kit staging isolé), #160 (statut d'émission), #163 (Stripe) et #165 (HTTP); ne pas écraser ni dupliquer ces changements. La CI verte ne remplace pas leurs revues.
4. Ne tenter aucun déploiement ou fournisseur réel sans les gates TLS, staging dédié, fiscalité, revues, privilèges et GO/NO-GO validés.
