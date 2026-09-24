# Registre local des factures émises confirmées

Cette brique matérialise localement une facture comme **`ISSUED_CONFIRMED`** uniquement après que la chaîne fournisseur a déjà atteint `ProviderExecution.state = CONFIRMED`.

Elle ne lance aucun appel Wave et n'envoie rien au client.

## Source de vérité exigée

La matérialisation exige, dans la même entreprise :

1. l'autorisation d'émission OWNER persistée;
2. le brouillon immuable correspondant;
3. l'exécution fournisseur correspondante;
4. `state = CONFIRMED`;
5. un `providerInvoiceId` et un numéro officiel;
6. une preuve de CREATE Wave persistée dont le `providerInvoiceId` est identique.

Un CREATE seulement confirmé n'est pas suffisant. Un état `IN_PROGRESS`, `AMBIGUOUS`, `FAILED_RETRYABLE` ou `FAILED_FINAL` ne peut pas créer le registre émis.

## Données persistées

`facturations_issued_invoices` conserve de façon append-only :

- tenant / business;
- authorization, draft et execution IDs;
- fournisseur;
- provider invoice ID;
- numéro officiel;
- hash du brouillon source;
- snapshot immuable du brouillon;
- `status = ISSUED_CONFIRMED`;
- `delivery_state = NOT_AUTHORIZED`;
- date de confirmation fournisseur;
- date de matérialisation locale.

Le brouillon source reste lui-même `DRAFT` et n'est jamais réécrit.

## Idempotence

Une même facture ne peut être matérialisée qu'une fois par tenant/draft/execution/provider invoice/numéro officiel.

Un second appel identique retourne le même registre. Toute divergence de chaîne devient un conflit.

## Livraison séparée

`delivery_state = NOT_AUTHORIZED` est volontaire. Cette brique ne contient :

- aucun `invoiceSend`;
- aucun fournisseur de courriel;
- aucun PDF officiel;
- aucun paiement;
- aucun accès portail client.

La future livraison devra avoir sa propre confirmation, son propre journal et ses propres états; elle ne pourra pas déduire une autorisation d'envoi du simple fait qu'une facture est émise.

## Tests

Les tests utilisent seulement PostgreSQL jetable et identifiants synthétiques `example.test`. Aucun token Wave ni appel réseau réel.
