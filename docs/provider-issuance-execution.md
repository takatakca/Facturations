# Moteur d'exécution fournisseur — état persistant, aucun appel réel

Ce lot commence seulement après une autorisation OWNER `AUTHORIZED_PENDING_PROVIDER`.

## États

- `PREPARED` : tentative créée avec une clé d'opération stable.
- `IN_PROGRESS` : un adapter injecté a été autorisé à tenter l'opération.
- `AMBIGUOUS` : le résultat externe est inconnu. **Aucun retry automatique n'est permis.**
- `CONFIRMED` : l'adapter ou une réconciliation a fourni un identifiant et un numéro fournisseur.
- `FAILED` : échec déterministe ou résultat ambigu réconcilié comme non créé.

Chaque transition est inscrite dans `facturations_provider_issuance_events`, journal append-only. La tentative principale garde l'état courant.

## Idempotence et résultats ambigus

La clé `operation_key` est dérivée de l'entreprise, de l'autorisation et du `request_hash` immuable. Repréparer la même autorisation retourne la même tentative.

Une exception de l'adapter ou une réponse invalide devient `AMBIGUOUS`. Une seconde exécution depuis cet état est refusée avant d'appeler l'adapter. Seule une réconciliation explicite peut terminer la tentative en `CONFIRMED` ou `FAILED`.

## Limite volontaire

`src/provider-issuance-executor.js` reçoit un adapter injecté. Aucun URL, jeton Wave ou client réseau Wave n'est créé ici. Les tests utilisent uniquement des adapters synthétiques.

Même lorsqu'une tentative simulée atteint `CONFIRMED`, `invoice_drafts.status` reste `DRAFT` et le résultat local expose encore `issued:false`, `waveSynced:false`, `emailed:false`. La création d'un véritable enregistrement d'émission officielle et la mutation Wave restent une étape distincte, soumise à environnement autorisé et réconciliation.

Migration : `db/012_provider_issuance_attempts.sql`.
