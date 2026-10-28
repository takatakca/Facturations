# Facturations — État vérifié du projet

Dernière vérification de GitHub : **2026-10-28**. Source de vérité : [`AGENTS.md`](../AGENTS.md), [`README.md`](../README.md), [audit #27](https://github.com/takatakca/Facturations/issues/27) et [GO / NO-GO](staging-go-no-go.md). Ce document est un instantané, **pas** une preuve de déploiement.

## Vérification du 28 octobre 2026

`main` reste protégée au SHA `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3`; les PR #164, #166 et #171 sont ouvertes. Le HEAD de #166 avant actualisation était `9d5ebe1284b1770cdce7156130d993b1471e61c6`, 10/10 jobs réussis. Nouveau HEAD code #171 `efbe5236ca9289f7e49e497e99a0f61cea2fe7fc` : si `markDraining()` échoue, HTTP et PostgreSQL sont tout de même arrêtés avec code de sortie d'échec; test ajouté. La CI du nouveau HEAD doit être vérifiée séparément. Note de relève privée de secrets dans Google Drive : [28 octobre](https://docs.google.com/document/d/1zp7-QT51to9iJx4zK0TeJh-lO3rVI7uWspXQZdvyUX8/edit). La note Drive du 27 octobre confirme qu'il n'existe pas de connexion Facturations → Food Hub/QCMEV/ON2GO; ne pas mélanger facturation B2B et tickets de caisse.

## Références Git

- Dépôt : `takatakca/Facturations`, branche principale protégée `main`.
- SHA `main` vérifié au début de cette reprise : `995d5cbb6296fca5ea852985c2cb9c4e4d89f2d3`.
- **PR #171 — Délai dur d'arrêt :** dernier HEAD `9d1e1615239efdbd3ac62e80d095c7de9095478b` : la fermeture HTTP et PostgreSQL respecte désormais une échéance commune, même si les callbacks ne reviennent pas; nouveaux tests avec timers simulés, erreur de forçage HTTP protégée; **10/10 checks GitHub Actions `success` sur le HEAD**, zéro échec; revue requise, non fusionné.
- **PR #171 — Fermeture sûre du pool PostgreSQL :** [correction en revue](https://github.com/takatakca/Facturations/pull/171), SHA initial `897137b19bf95f82e81247127a79c9014cbee95c` (10/10 CI); HEAD `1cbf7735fbc3b43a28a77a23a9776ffbda3c99fd` (**10/10 checks GitHub Actions réussis**) : ferme PostgreSQL même si la fermeture HTTP échoue, et traite correctement les erreurs de callback HTTP; tests négatifs de fermeture et synchronisation des appels concurrents; runbook GO-LIVE actualisé; **CI du HEAD vérifiée**, revue indépendante attendue, non fusionnée.
- **PR #170 — Disponibilité pendant l'arrêt :** [correctif autonome](https://github.com/takatakca/Facturations/pull/170), SHA `2fd6251a19deb66bc44ba36c32052f601093d82f` : `/ready` se verrouille après `markDraining()` même si une requête DB antérieure réussit tardivement, tests de race condition, guide GO-LIVE actualisé. Revue indépendante demandée, **10/10 contrôles GitHub Actions `success`** au SHA indiqué, **non fusionné**.
- **PR #169 — Garde Stripe en production** : [correction P0](https://github.com/takatakca/Facturations/pull/169), SHA initial `c54decd8857e7e2e97526139707e328c4baa7758` (10/10 checks verts); nouveau HEAD `731faefc5a2ae833d9ab51a3145e282d5a1d6086` (**10/10 checks verts**) : refuse `FACTURATIONS_STRIPE_ALLOW_TEST_MODE=1` en production et requiert `livemode` booléen explicite, tests ajoutés (dont UTF-8 strict pour payload signé), verdict complet à vérifier sur nouveau HEAD; revue indépendante en attente, non fusionnée.
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
