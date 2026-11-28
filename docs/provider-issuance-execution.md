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

## Liaison payload ↔ autorisation

Le plan fournisseur transporte `sourceRequestHash`, calculé sur le même preview serveur déterministe que le `request_hash` du brouillon immuable, ainsi qu'un `providerPlanHash` calculé sur le plan Wave canonique complet : business, client, produits, taxes, dates, montants et actions externes attendues.

La préparation engage ces deux hashes dans l'`operation_key`. Repréparer la même autorisation avec d'autres mappings fournisseur déclenche `PREPARE_CONFLICT`.

Avant de passer une tentative de `PREPARED` à `IN_PROGRESS`, l'executor recalcule `providerPlanHash`, puis le store recalcule l'`operation_key` attendue avec l'autorisation persistée. Une modification du plan sans rehash déclenche `PROVIDER_PLAN_HASH_MISMATCH`; un plan correctement rehashé mais différent de celui figé à la préparation déclenche `PROVIDER_PAYLOAD_BINDING_MISMATCH`. Dans les deux cas, aucun appel adapter n'est effectué.

## Compatibilité du document officiel

Avant de produire un plan fournisseur, le preflight vérifie maintenant que tous les textes du brouillon destinés au PDF officiel v1 sont représentables par le renderer WinAnsi actuel. Un caractère non supporté bloque l'émission avec `PDF_TEXT_UNSUPPORTED` avant tout appel provider.

Le brouillon lui-même peut rester éditable avec Unicode : la restriction s'applique à la frontière d'émission tant que le moteur PDF v1 n'embarque pas de police Unicode.

## Limite volontaire

`src/provider-issuance-executor.js` reçoit un adapter injecté. Aucun URL, jeton Wave ou client réseau Wave n'est créé ici. Les tests utilisent uniquement des adapters synthétiques.

Même lorsqu'une tentative simulée atteint `CONFIRMED`, `invoice_drafts.status` reste `DRAFT` et le résultat local expose encore `issued:false`, `waveSynced:false`, `emailed:false`. La création d'un véritable enregistrement d'émission officielle et la mutation Wave restent une étape distincte, soumise à environnement autorisé et réconciliation.

Migration : `db/012_provider_issuance_attempts.sql`.
