# Exécution fournisseur — état simulé avant intégration Wave

Ce lot prépare la gestion sûre d'une future émission externe **sans appeler Wave**.

## But

Une autorisation propriétaire `AUTHORIZED_PENDING_PROVIDER` existe déjà après l'approbation interne. Le moteur de ce lot ajoute une couche de persistance pour empêcher les doublons lorsqu'un fournisseur externe répond lentement, échoue ou laisse un résultat ambigu.

Migration : `db/012_provider_issuance_execution.sql`.

## Modèle append-only

Trois tables séparées conservent l'historique :

- `facturations_provider_issuance_attempts` : une tentative identifiée par une clé idempotente;
- `facturations_provider_issuance_results` : exactement un résultat pour une tentative;
- `facturations_provider_issuance_reconciliations` : au plus une résolution après un résultat ambigu.

Les trois tables refusent UPDATE et DELETE. Aucun secret Wave, jeton ou contenu HTTP fournisseur n'est stocké.

## États de résultat

Une tentative peut recevoir :

- `CONFIRMED` : le fournisseur est présenté comme ayant confirmé un identifiant et un numéro;
- `AMBIGUOUS` : impossible de savoir si l'opération externe a eu lieu;
- `FAILED_RETRYABLE` : aucune confirmation externe, une nouvelle tentative est permise;
- `FAILED_FINAL` : arrêt manuel/technique, nouvelle tentative interdite.

Dans ce lot, ces résultats sont injectés uniquement par les tests ou par du code backend futur. **Le store lui-même ne fait aucun appel réseau.**

## Règle critique des résultats ambigus

Après `AMBIGUOUS`, une nouvelle tentative est refusée avec `RECONCILIATION_REQUIRED`.

La réconciliation doit ensuite enregistrer l'une des deux conclusions :

- `CONFIRMED_EXISTING` : une facture existe déjà chez le fournisseur; tout retry est interdit;
- `NOT_FOUND` : aucune facture correspondante n'a été trouvée; une nouvelle tentative peut être créée avec une nouvelle clé.

Ainsi, un timeout ne devient jamais automatiquement un deuxième appel de création.

## Idempotence

- le même `attemptKey` pour la même autorisation retourne la tentative existante;
- le même résultat exact peut être rejoué sans créer un doublon;
- la même réconciliation exacte peut être rejouée;
- un résultat ou une réconciliation contradictoire retourne un conflit.

## Ce lot ne fait toujours pas

- aucun appel Wave;
- aucune mutation GraphQL de facture;
- aucun numéro officiel produit par Facturations;
- aucune transition locale de `invoice_drafts.status`, qui reste `DRAFT`;
- aucun PDF officiel;
- aucun courriel;
- aucun paiement.

La prochaine étape doit connecter un **adaptateur Wave simulé** au moteur, avec requête et réponse strictement structurées, avant tout test avec un compte Wave autorisé.
