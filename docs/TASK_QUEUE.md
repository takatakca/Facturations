# Facturations — File des tâches

Date de triage : 2026-10-16. Statuts : `DONE_PR` = code poussé mais pas nécessairement fusionné; `REVIEW` = attendre une revue autorisée; `BLOCKED_EXTERNAL` = preuve réelle ou accès opérateur absent. Les tâches peuvent évoluer; toujours comparer à GitHub avant d'agir.

| Priorité | Tâche | État vérifié | Prochaine action |
| --- | --- | --- | --- |
| P0 | Libérer PostgreSQL et signaler une erreur lors d'un arrêt HTTP défectueux | [#171](https://github.com/takatakca/Facturations/pull/171), SHA `897137b19bf95f82e81247127a79c9014cbee95c`, code/tests/runbook poussés | Vérifier le SHA CI, revue indépendante, fusion seulement selon les règles GitHub |
| P0 | Empêcher `/ready` de rester vert pendant un arrêt serveur avec requête DB déjà en cours | [#170](https://github.com/takatakca/Facturations/pull/170), SHA `2fd6251a19deb66bc44ba36c32052f601093d82f`, code/tests/runbook poussés, **10/10 checks verts** | Obtenir revue indépendante; fusion autorisée seulement après protections |
| P0 | Empêcher les preuves de paiement Stripe de test en production | [#169](https://github.com/takatakca/Facturations/pull/169), SHA initial `c54decd8857e7e2e97526139707e328c4baa7758` (10/10 verts), HEAD `731faefc5a2ae833d9ab51a3145e282d5a1d6086` (UTF-8 strict, **10/10 checks verts**) | Attendre revue indépendante, puis fusion autorisée, fusion selon protection de `main` |
| P0 | Rejeter les preuves de préproduction de taille excessive ou de date ambiguë | [#168](https://github.com/takatakca/Facturations/pull/168), SHA `395d133795741ce202a3dd9eab23e10c7b7dc4e5`, code/tests/docs poussés | Examiner les checks du HEAD exact, corriger tout échec, attendre revue indépendante; aucun GO réel n'est validé |
| P0 | Refuser les cookies de portail client surdimensionnés | [#167](https://github.com/takatakca/Facturations/pull/167) : code/tests poussés, 10/10 checks verts au SHA `16be6d2f7b716dc6ab44975ee8818665ba695ab3` | Revue indépendante, fusion selon règles GitHub |
| P0 | Réparer les formulaires et la connexion Chromium | [#158](https://github.com/takatakca/Facturations/pull/158) : code et test proposés, non fusionnés | Revue indépendante du SHA exact, CI puis fusion autorisée |
| P0 | Durcir l'ingestion Stripe (taille du corps, requête avortée) | [#163](https://github.com/takatakca/Facturations/pull/163) : `DONE_PR`, 10 checks verts, revue demandée | Intégrer les remarques de revue, fusionner selon protection |
| P0 | Éviter les lectures JSON bloquées sur uploads interrompus | [#165](https://github.com/takatakca/Facturations/pull/165) : `DONE_PR`, 10/10 checks verts, revue en attente | Revue indépendante, fusion selon règles GitHub |
| P0 | Consolider les outils de relève et vérifier leur présence en CI | [#164](https://github.com/takatakca/Facturations/pull/164), CI verte, revue en attente | Examiner et fusionner selon protection de main |
| P0 | Interdire le UTF-8 invalide dans les documents de relève | [#166](https://github.com/takatakca/Facturations/pull/166), empilée sur #164 : correctif et tests poussés | Vérifier CI du HEAD final, revue #164 puis retargeter #166 |
| P1 | Préparer staging dédié et création du premier OWNER | [#159](https://github.com/takatakca/Facturations/pull/159) : kit Coolify proposé, non fusionné | Revue, puis construire un environnement isolé autorisé et vérifier HTTPS/DB/MFA |
| P1 | Exposer les statuts d'émission/solde à TAKATAK sans données étrangères | [#160](https://github.com/takatakca/Facturations/pull/160) : implémentation proposée, non fusionnée | Revue, CI, test interentreprises, fusion |
| P1 | Règle de worklog et outil Claude de relève | [#162](https://github.com/takatakca/Facturations/pull/162) : PR documentation en attente | Examiner les éventuels conflits avec ces cinq nouveaux documents |
| P2 | Consolider la chaîne des PR IA et UX (dont #122–#147) | Plusieurs PR ouvertes, dépendances entre branches | Examiner ordre, test, sécurité des actions proposées, revues une par une |
| P2 | Connecteur Wave d'émission réelle et réconciliation | `BLOCKED_EXTERNAL` : compte de test autorisé, mappings et preuves fournisseur absents | Définir et tester dans environnement isolé; ne pas activer les écritures réelles |
| P2 | Livraisons email, callbacks signés et preuves de remise | `BLOCKED_EXTERNAL` | Valider le fournisseur, domaine, signature et sandbox; garder les envois réels désactivés |
| P2 | Fiscalité, profil émetteur, règles d'accès client et vie privée | `BLOCKED_EXTERNAL` | Validation juridique/comptable et tests de séparation des données |
| P2 | Sauvegarde/restauration, vulnérabilités, accessibilité, exploitation et GO/NO-GO | `BLOCKED_EXTERNAL` | Exercices réels et preuves du SHA déployé, pas seulement CI synthétique |

## Règles d'exécution

1. Lire `AGENTS.md`, `README.md`, `PROJECT_STATUS.md` et les PR ouvertes.
2. Ne pas commencer une fonctionnalité déjà développée sur une branche existante; vérifier sa diff et sa base.
3. Corriger les tests rouges et les failles bloquantes avant d'ajouter des fonctionnalités.
4. N'effectuer aucune opération financière réelle ni déploiement sur des systèmes TAKATAK existants sans ses autorisations spécifiques.
5. Après chaque tâche, actualiser `AGENT_HANDOFF.md` et les statuts sans présenter les mocks comme du réel.
