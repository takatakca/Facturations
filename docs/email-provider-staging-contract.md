# Contrat fournisseur courriel de staging

Cette brique définit le contrat qu’un futur fournisseur courriel devra respecter. Elle ne choisit aucun fournisseur commercial et n’effectue aucune connexion réseau réelle.

## Deux niveaux séparés

### 1. Résultat de soumission API

Une soumission peut seulement produire :

- `ACCEPTED` : le fournisseur a accepté la requête et retourne un `providerMessageId`;
- `FAILED` : refus conclusif avec code interne;
- `AMBIGUOUS` : résultat inconnu, invalide, timeout ou exception.

**ACCEPTED ne signifie jamais DELIVERED.**

Le contrat transporte la clé d’opération/idempotence, le destinataire exact, le PDF qualifié exact et son SHA-256.

## 2. Preuve asynchrone fournisseur

Les événements de preuve autorisés sont séparés :

- `DELIVERED`;
- `BOUNCED`;
- `COMPLAINT`.

Chaque événement doit fournir :

- `providerKey`;
- ID événement fournisseur;
- message ID fournisseur;
- type;
- timestamp ISO exact;
- destinataire.

Un événement `ACCEPTED` n’est pas accepté dans ce canal parce qu’il s’agit du résultat de soumission, pas d’une preuve de remise.

## Fail closed

Une exception réseau lors de la soumission devient `AMBIGUOUS / PROVIDER_EXCEPTION`.

Un résultat fournisseur incomplet ou inconnu devient `AMBIGUOUS / PROVIDER_RESULT_INVALID`.

Un event provider invalide est rejeté; il n’est jamais transformé silencieusement en `DELIVERED`.

## Frontière actuelle

`src/email-provider-contract.js` est uniquement une interface et une normalisation.

Il n’y a :

- aucun SDK fournisseur;
- aucune clé API;
- aucun SMTP;
- aucun webhook;
- aucune URL publique;
- aucun courriel réel;
- aucune persistance d’événements réels.

La prochaine étape est un ledger PostgreSQL append-only pour ces preuves, alimenté uniquement par des événements synthétiques jusqu’au choix du fournisseur de staging.
