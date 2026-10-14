# Facturations — File des tâches

Date de triage : 2026-10-14. Statuts : `DONE_PR` = code poussé mais pas nécessairement fusionné; `REVIEW` = attendre une revue autorisée; `BLOCKED_EXTERNAL` = preuve réelle ou accès opérateur absent. Les tâches peuvent évoluer; toujours comparer à GitHub avant d'agir.

| Priorité | Tâche | État vérifié | Prochaine action |
| --- | --- | --- | --- |
| P0 | Réparer les formulaires et la connexion Chromium | [#158](https://github.com/takatakca/Facturations/pull/158) : code et test proposés, non fusionnés | Revue indépendante du SHA exact, CI puis fusion autorisée |
| P0 | Durcir l'ingestion Stripe (taille du corps, requête avortée) | [#163](https://github.com/takatakca/Facturations/pull/163) : `DONE_PR`, 10 checks verts, revue demandée | Intégrer les remarques de revue, fusionner selon protection |
| P0 | Consolider les outils de relève et vérifier leur présence en CI | Cette PR de documentation | Terminer les checks de cette PR et demander une revue |
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
