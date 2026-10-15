# Facturations — État vérifié du projet

Dernière vérification de GitHub : **2026-10-15**. Source de vérité : [`AGENTS.md`](../AGENTS.md), [`README.md`](../README.md), [audit #27](https://github.com/takatakca/Facturations/issues/27) et [GO / NO-GO](staging-go-no-go.md). Ce document est un instantané, **pas** une preuve de déploiement.

## Références Git

- Dépôt : `takatakca/Facturations`, branche principale protégée `main`.
- SHA `main` vérifié au début de cette reprise : `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3`.
- **PR #169 — Garde Stripe en production** : [correction P0](https://github.com/takatakca/Facturations/pull/169), SHA `c54decd8857e7e2e97526139707e328c4baa7758` : refuse `FACTURATIONS_STRIPE_ALLOW_TEST_MODE=1` en production et requiert `livemode` booléen explicite, tests ajoutés, revue et CI en cours, non fusionnée.
- **PR #168 — Validation des preuves de staging** : [correctif autonome](https://github.com/takatakca/Facturations/pull/168), SHA `395d133795741ce202a3dd9eab23e10c7b7dc4e5` : horodatage UTC canonique, JSON privé limité à 64 Kio, UTF-8 strict et liens symboliques refusés; CI/revue en cours au dernier relevé, non fusionné.
- Dernier HEAD documenté de [PR #166](https://github.com/takatakca/Facturations/pull/166) avant cette actualisation : `21111e9192dbc9eaa5ca213ad880064bce6603d0`, 10/10 checks GitHub Actions réussis; toujours empilée sur #164 et non fusionnée.
- Nouveau correctif HTTP portail client [PR #167](https://github.com/takatakca/Facturations/pull/167), commit `16be6d2f7b716dc6ab44975ee8818665ba695ab3` : borne du champ Cookie à 4096 caractères et tests sur la non-divulgation; 10/10 contrôles GitHub Actions réussis sur le SHA indiqué, revue demandée, non fusionné.
- Correction documentaire UTF-8 : [PR #166](https://github.com/takatakca/Facturations/pull/166), empilée sur #164; le SHA initial `f39cfaf5a2a4f8a1fc7832b3943c2d0572397a78` a réussi 5/5 jobs, les vérifications finales doivent porter sur le HEAD révisé.
- PR documentaire [#164](https://github.com/takatakca/Facturations/pull/164) : CI du SHA `2ee146883e5bb301d3a30c6cf24dd6cdce9e2c6e` réussie; encore ouverte/non fusionnée.
- Correctif JSON indépendant : [PR #165](https://github.com/takatakca/Facturations/pull/165), SHA `653c90cda1b8c102f5e0a57f37d17b767d900b10` (lectures de corps JSON avortées et taille bornée; 10/10 contrôles réussis au SHA indiqué, non fusionné).
- Correctif indépendant déjà poussé : [PR #163](https://github.com/takatakca/Facturations/pull/163), SHA `347564627b5e4755d9d3de95de6c730056e7ec4c` (10 contrôles GitHub Actions réussis, fusion bloquée en attente de revue).
- Les PR #158, #159, #160 et #162 sont **ouvertes mais non fusionnées** au dernier contrôle; ne pas attribuer leurs fonctions à `main`.
- La chaîne de PR IA #122–#147 est également en attente; certaines branches sont empilées, inspecter les bases avant toute fusion.

## Livré dans le code de main (non homologué en production)

Le dépôt contient l'authentification staff avec MFA, la gestion privée de brouillons et de clients, l'approbation interne, l'autorisation séparée d'émission, les registres immuables, les PDF qualifiés, la preuve de paiement Stripe signée, le portail client en lecture et des suites de tests sur PostgreSQL jetable. Le code de `main` ne constitue **pas** la preuve d'un parcours réel de facturation ou de mise en ligne.

Les états `SYNTHETIC_TEST` / `SIMULATED_EMAIL` ne sont pas des confirmations de versement ou de remise. Aucune preuve disponible dans ce dossier ne permet de déclarer une émission Wave réelle, une livraison email réelle, une homologation fiscale ou un site de production en santé.

## Validation observée

La PR #163 a exécuté avec succès les workflows de tests Node 20/22, Chromium MFA/PostgreSQL, navigateur et contrôle des privilèges DB. Ces résultats portent uniquement sur le SHA de la PR, **pas** sur un staging public ou un `main` fusionné.

## État opérationnel

- **Production : NON HOMOLOGUÉE / NON DÉPLOYÉE selon la documentation vérifiée.**
- **Staging isolé : aucune installation vérifiée**. [PR #159](https://github.com/takatakca/Facturations/pull/159) propose un kit Coolify/Contabo mais n'est pas fusionnée.
- `facturations.bolon.ca` : HTTPS public, proxy, base dédiée et santé non prouvés.
- Fournisseurs Wave/email/paiements réels : gates séparés non levés.
- Protection de `main` constatée; les paramètres exacts de la règle de protection ne sont pas lisibles par ce connecteur (403), et aucune revue humaine indépendante n'a été observée sur #158, #159, #160 et #163.

## Où continuer

Consulter [`TASK_QUEUE.md`](TASK_QUEUE.md), puis [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md). Toute affirmation de réussite doit citer le SHA, les checks et une preuve réelle correspondant à son périmètre.
