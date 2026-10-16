# Facturations — Relève entre agents

**Actualisé : 2026-10-16**. Pour éviter une référence circulaire, le dernier commit de **la branche en cours** doit toujours être relu depuis GitHub (`git rev-parse HEAD` ou API); le SHA ci-dessous est le dernier commit de **code vérifié de la session précédente**, pas une assertion sur la tête de cette PR documentaire.

## Reprise technique du 2026-10-16 — tâche réellement poussée

- **Dépôt / base :** `takatakca/Facturations`, `main` protégée au SHA `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3` au contrôle. L'ancienne PR #169 reste ouverte et ses 10/10 checks sur `731faefc5a2ae833d9ab51a3145e282d5a1d6086` sont confirmés. Le HEAD de #166 avant ce relevé était `c9cf734f79d43c08fc4e646e7854a486906ef10e`, 10/10 checks verts.
- **Dernière tâche de code terminée :** [PR #170](https://github.com/takatakca/Facturations/pull/170), branche `fix/readiness-draining-inflight-20261016`, SHA `2fd6251a19deb66bc44ba36c32052f601093d82f`. La vérification `/ready` refuse un résultat PostgreSQL réussi si le serveur entre en mode arrêt pendant la requête; l'ancien code contrôlait l'état uniquement avant `await`.
- **Fichiers modifiés sur la branche #170 :** `src/readiness-probe.js`, `tests/readiness-probe.test.js`, `docs/final-go-live-runbook.md`. Les tests ajoutés déclenchent une requête asynchrone différée, puis `markDraining()`, vérifient le résultat faux et l'absence de requêtes suivantes, et couvrent une exception différée sans fuite.
- **Vérifications exécutées :** lecture `AGENTS.md`, des cinq documents de relève, des PR/issues et Actions via GitHub; diff de #170 vérifiée; revue indépendante demandée à `takatakmtl`. Les GitHub Actions de #170 au SHA exact `2fd6251a19deb66bc44ba36c32052f601093d82f` ont terminé : **10/10 checks `success`**, aucun échec (Node 20/22, Chromium, MFA/PostgreSQL, privilèges runtime). Une réussite CI n'est pas une preuve de staging. Aucun clone ni test local intégré attesté.
- **Statut du déploiement :** non exécuté, non homologué. Aucun accès PostgreSQL réel, aucune facture, émission Wave, email client, paiement ou remboursement.
- **Accès / preuves manquantes :** approbation indépendante GitHub des PR ouvertes, environnement staging Facturations dédié (base, reverse-proxy HTTPS et sauvegarde), validation du GO/NO-GO, attestations des fournisseurs et revue fiscale/comptable.
- **Prochaine action exacte :** la CI de #170 est 10/10 verte au SHA `2fd6251a19deb66bc44ba36c32052f601093d82f` : obtenir revue `takatakmtl` sans contourner la protection de `main`; poursuivre #164 puis #166 dans cet ordre avant de retargeter; n'intégrer les autres PR qu'après leurs revues et validations. Le HEAD de la branche documentaire **change à chaque édition** : le lire via GitHub, ne pas confondre avec le SHA de code #170.

## Dernière tâche terminée

**Correctif de disponibilité de l'arrêt serveur** poussé dans [PR #170](https://github.com/takatakca/Facturations/pull/170), code SHA `2fd6251a19deb66bc44ba36c32052f601093d82f`, **10/10 GitHub Actions checks `success`** au SHA exact. `src/readiness-probe.js` recontrôle `draining` après `await pool.query`, empêchant une réussite SQL tardive d'afficher READY pendant SIGTERM. Tests de concurrence/fuite ajoutés dans `tests/readiness-probe.test.js`, gate dans `docs/final-go-live-runbook.md`. Poussé mais **non fusionné** : revue indépendante `takatakmtl` attendue. Aucun staging ni déploiement prouvé.

**Correctif antérieur :** [PR #169](https://github.com/takatakca/Facturations/pull/169), SHA `731faefc5a2ae833d9ab51a3145e282d5a1d6086`, 10/10 checks `success` : refuse le mode test Stripe en production, exige `livemode` explicite et rejette les octets UTF-8 malformés même après signature HMAC. Toujours en attente de revue et non fusionné.

## Travail applicatif supplémentaire poussé

[PR #165](https://github.com/takatakca/Facturations/pull/165), SHA `653c90cda1b8c102f5e0a57f37d17b767d900b10` : lecteur JSON de brouillon avec limites et traitement d'abandon, nouveaux tests; revue indépendante demandée. Vérifier les jobs GitHub Actions du SHA exact, encore en cours lors de la mise à jour.

## Nouvelle tâche terminée en branche indépendante

[PR #167](https://github.com/takatakca/Facturations/pull/167), branche `fix/client-cookie-header-bound-20261014`, commit `16be6d2f7b716dc6ab44975ee8818665ba695ab3` : refuse les en-têtes `Cookie` du portail client dépassant 4096 caractères (même borne que les cookies du personnel). Les tests couvrent le seuil 4096/4097, les doublons, et le rejet HTTP 401 sur liste/détails/PDF sans lecture du store; un cookie valide reste autorisé. Fichiers : `src/client-session-cookie.js`, `tests/client-session-cookie.test.js`, `tests/browser-client-portal.test.js`. CI GitHub Actions **10/10 `success`** au SHA `16be6d2f7b716dc6ab44975ee8818665ba695ab3`; revue `takatakmtl` demandée; toujours **non fusionnée**.

## Travail terminé lors de la reprise du 2026-10-15

- Après relecture de `AGENTS.md`, des PR ouvertes, des issues et de la CI, `main` reste protégé au SHA `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3`. Les PR #164, #166 et #167 restent en attente de revue humaine `takatakmtl`.
- Vérification du précédent HEAD #166 `21111e9192dbc9eaa5ca213ad880064bce6603d0` : **10/10 checks `success`**.
- [PR #168](https://github.com/takatakca/Facturations/pull/168) indépendante créée contre `main`, branche `fix/staging-evidence-input-guard-20261015`, SHA du dernier correctif poussé `395d133795741ce202a3dd9eab23e10c7b7dc4e5`. Fichiers : `src/staging-readiness-evaluator.js`, `scripts/evaluate-staging-readiness.js`, `tests/staging-readiness-evaluator.test.js`, `tests/staging-evidence-file.test.js` et `docs/staging-go-no-go.md`. Contrôle d'horodatage UTC canonique, fichier JSON privé borné à 65 536 octets et décodage UTF-8 strict; symlinks rejetés. Aucun changement fournisseur, DB ou production.
- Checks #168 déclenchés dans GitHub Actions, résultats finaux à confirmer sur ce SHA; revue demandée à `takatakmtl`.
- Aucun test contre un serveur de production, aucune migration, émission Wave, remise d'email ou paiement réel. Le statut du déploiement est **non homologué/non vérifié**.

## Correction de sécurité en cours de validation — Stripe

- [PR #169](https://github.com/takatakca/Facturations/pull/169) ouverte contre `main` protégé (SHA `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3`), branche `fix/stripe-test-mode-production-gate-20261015`, dernier commit poussé `731faefc5a2ae833d9ab51a3145e282d5a1d6086` (UTF-8 strict, test et documentation additionnels); premier SHA validé `c54decd8857e7e2e97526139707e328c4baa7758`.
- Anomalie : `NODE_ENV=production` acceptait `FACTURATIONS_STRIPE_ALLOW_TEST_MODE=1`, malgré le caractère staging-only; et `stripeEventScope` acceptait les événements sans `livemode` booléen explicite si l'option était activée.
- Correctif : `src/config.js` bloque cette configuration en production; `src/stripe-payment-webhook.js` ne permet que `livemode === true` ou `livemode === false` avec autorisation staging. Tests de configuration et de portée dans `tests/config.test.js`, `tests/stripe-payment-webhook.test.js`; documentation `docs/stripe-verified-payment-webhook.md`.
- GitHub Actions sur le SHA `c54decd8857e7e2e97526139707e328c4baa7758` : **10/10 contrôles `success`**, zéro échec (tests Node 20/22, navigateur Chromium, MFA/PostgreSQL et privilèges runtime). Revue humaine demandée `takatakmtl`; aucune fusion.
- Correction additionnelle sur la même PR : rejet du JSON Stripe signé contenant de l'UTF-8 malformé avant parsing, avec test HMAC valide sur octets invalides. HEAD `731faefc5a2ae833d9ab51a3145e282d5a1d6086` : **10/10 contrôles GitHub Actions `success` sur le SHA final**, aucun échec (Node 20/22, Chromium, MFA/PostgreSQL, contrôle DB).
- PR #168 au SHA `395d133795741ce202a3dd9eab23e10c7b7dc4e5` et #166 à l'ancien SHA `6a1fcf41bc3359d02c1eefa771763032e6710797` : 10/10 checks chacun lors du dernier contrôle; nouvelles écritures documentaires changent le SHA de #166.
- Aucune migration, mise en ligne, émission Wave, courriel client, charge ni remboursement Stripe. `main` non modifié et staging isolé non attesté.

## Tâche en cours

Faire homologuer les PR #164 et #166 et réintégrer les correctifs Stripe #169 et HTTP #167 sous revue humaine; aucune fusion ni production avant gates. La partie technique du correctif de validation UTF-8 des documents de relève est terminée sur `fix/project-docs-strict-utf8-20261014`, [PR #166](https://github.com/takatakca/Facturations/pull/166) empilée sur [PR #164](https://github.com/takatakca/Facturations/pull/164). La lecture du handoff avec `TextDecoder('utf-8', { fatal: true })` bloque désormais les octets invalides au lieu de les remplacer silencieusement. Le test de régression couvre aussi des caractères FR, ES et chinois valides. Le contrôle rejette désormais les fichiers et répertoires `docs` symboliquement liés, empêchant CI de suivre des chemins extérieurs au checkout.

**Dernier commit technique poussé dans cette branche à la présente mise à jour :** `6e02f7ba3582bd607814902dd931fb6f02b3d416` (tests contre les symlinks); correctif symlink `24f32e95e346e47bc973f468d5e57184a503ba4f`; tests UTF-8 `d7ef397a798e65222f38fba185f869f1925ea3d2`; commit initial du fix `f39cfaf5a2a4f8a1fc7832b3943c2d0572397a78`. Après toute modification de ce document, lire le nouveau SHA HEAD GitHub; une annotation du SHA dans un commit qu'elle modifie ne peut pas être autoréférentielle.

## Références et fichiers

- `main` constaté : `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3` (protégé).
- Code de #163 : `src/stripe-raw-body.js`, `src/stripe-payment-webhook-route.js`, `tests/stripe-webhook-body.test.js`, `docs/stripe-verified-payment-webhook.md`.
- Correctif UTF-8 de #166 : `scripts/check-project-docs.js`, `tests/project-docs.test.js`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`.
- Branche de relève (#164) : `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `scripts/check-project-docs.js`, `tests/project-docs.test.js`, `package.json`, `.github/workflows/ci.yml`.

## Vérifications réellement exécutées

- #167 SHA `16be6d2f7b716dc6ab44975ee8818665ba695ab3` : GitHub Actions **10/10 success** sur push et PR, comprenant Node 20/22, Chromium, MFA/PostgreSQL et runtime least privilege. Les tests de cookie et les assertions HTTP s'exécutent dans `npm test`.

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

1. #169 au SHA final `731faefc5a2ae833d9ab51a3145e282d5a1d6086` a 10/10 checks verts : attendre revue indépendante `takatakmtl` avant fusion selon protection `main`.
2. Obtenir la revue indépendante de #169, maintenir le rejet du mode test en production et ne fusionner qu'après les gates GitHub.
3. Vérifier les jobs du **nouveau** HEAD de #166 après cette mise à jour documentaire; #164 doit être approuvée/fusionnée en premier, puis #166 retargetée et revalidée.
4. Pour #158/#159/#160/#163/#165/#167/#168, intégrer les retours humains sans duplication de fonctionnalités; poursuivre une amélioration indépendante si possible.
5. Ne déployer ni ne déclencher de fournisseur réel sans approbation exacte et preuves HTTPS, DB dédiée, MFA, fiscalité et GO/NO-GO.

## Historique des prochaines actions précédemment relevées


1. Examiner tous les contrôles GitHub Actions du SHA `395d133795741ce202a3dd9eab23e10c7b7dc4e5` de #168, puis corriger tout échec sans toucher `main` ni au staging réel.
2. Maintenir la demande de revue indépendante de #168 et attendre l'autorisation de fusion conforme à la protection de `main`.
3. #167 est CI verte au SHA `16be6d2f7b716dc6ab44975ee8818665ba695ab3` : attendre la revue indépendante et ne fusionner que selon les protections de `main`. Consulter les jobs du dernier SHA de #166 après cette mise à jour.
4. Vérifier les GitHub Actions du HEAD courant de la PR #166, incluant `npm run check:project-docs`, `npm run check` et `npm test`; corriger les erreurs avec un nouveau SHA.
5. Obtenir une revue indépendante de #164 puis la fusion autorisée sur `main`; retargeter ensuite #166 vers `main` et réexécuter les vérifications exactes.
6. Lire les PR #158 (login réel), #159 (kit staging isolé), #160 (statut d'émission), #163 (Stripe) et #165 (HTTP); ne pas écraser ni dupliquer ces changements. La CI verte ne remplace pas leurs revues.
7. Ne tenter aucun déploiement ou fournisseur réel sans les gates TLS, staging dédié, fiscalité, revues, privilèges et GO/NO-GO validés.
