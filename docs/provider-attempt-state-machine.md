# Machine d’état des tentatives fournisseur

Cette couche est **interne et sans réseau**. Elle ne contacte pas Wave.

## But

Empêcher les doubles émissions quand un appel fournisseur futur donne un résultat ambigu.

États :

- `PREPARED` : tentative enregistrée localement;
- `IN_FLIGHT` : le futur adaptateur a commencé l’opération;
- `CONFIRMED` : résultat fournisseur vérifié avec identifiant + numéro;
- `AMBIGUOUS` : timeout ou réponse inconnue; **aucun retry permis**;
- `FAILED_RETRYABLE` : échec explicitement sans création fournisseur, retry autorisé;
- `FAILED_FINAL` : échec définitif, aucun retry;
- `RECONCILED_NOT_FOUND` : recherche fournisseur explicite n’a trouvé aucune facture, retry autorisé.

## Règles de retry

Une nouvelle tentative est possible uniquement après :

- `FAILED_RETRYABLE`; ou
- `AMBIGUOUS → RECONCILED_NOT_FOUND`.

Un état `AMBIGUOUS` doit être réconcilié. Un nouveau retry est refusé tant que cette preuve n’existe pas.

Si la réconciliation trouve la facture, l’état devient `CONFIRMED` avec l’identifiant et le numéro fournisseur vérifiés.

## Idempotence locale

Chaque tentative a une clé `idempotency_key` unique dans l’entreprise. Rejouer exactement la même préparation avec la même clé et le même `plan_hash` retourne la tentative existante sans nouvel événement. Une même clé avec un autre brouillon ou plan est un conflit.

## Audit et protection PostgreSQL

`facturations_provider_attempt_events` est append-only.

La table principale autorise seulement les transitions prévues par la migration 012. Les champs d’identité de la tentative sont immuables. Les suppressions sont refusées.

## Frontière de sécurité

Même `CONFIRMED` dans cette machine d’état ne modifie pas encore `invoice_drafts.status` et ne signifie pas qu’un appel Wave réel a été effectué dans l’environnement actuel. Les tests utilisent uniquement des identifiants fictifs.

L’adaptateur Wave réel devra être un lot distinct, exécuté uniquement avec un compte de test autorisé et une stratégie de réconciliation vérifiée.
