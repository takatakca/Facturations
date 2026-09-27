# Réconciliation locale d'une émission fournisseur confirmée

Cette brique intervient **après** le moteur fournisseur persistant. Elle ne crée aucune facture chez Wave : elle matérialise seulement, dans PostgreSQL local, une facture comme `ISSUED_CONFIRMED` lorsque la tentative fournisseur correspondante est déjà `CONFIRMED`.

## Chaîne exigée

La matérialisation n'est possible que si, dans la même entreprise :

1. l'autorisation OWNER existe et reste `AUTHORIZED_PENDING_PROVIDER`;
2. son `draft_id` correspond exactement au brouillon immuable;
3. la tentative fournisseur pointe vers cette même autorisation et ce même brouillon;
4. le brouillon reste `DRAFT`;
5. le hash de l'autorisation est identique au hash du brouillon;
6. total et courriel attendus correspondent toujours au snapshot;
7. la tentative fournisseur est `CONFIRMED`;
8. l'identifiant fournisseur, le numéro officiel et la date de confirmation sont présents.

Une tentative `PREPARED`, `IN_PROGRESS`, `AMBIGUOUS` ou `FAILED` est refusée.

## Registre append-only

`facturations_issued_invoices` conserve :

- entreprise, autorisation, brouillon et tentative;
- fournisseur;
- identifiant de facture fournisseur;
- numéro officiel;
- hash et snapshot source;
- `status = ISSUED_CONFIRMED`;
- `delivery_state = NOT_AUTHORIZED`;
- date de confirmation fournisseur;
- date de matérialisation locale.

Les mises à jour et suppressions sont bloquées par trigger. Les clés uniques empêchent qu'un même brouillon, une même autorisation, une même tentative, un même identifiant fournisseur ou un même numéro officiel soit matérialisé deux fois dans une entreprise.

## Idempotence

Répéter la matérialisation de la **même** tentative confirmée retourne le même registre. Une divergence sur l'une des identités protégées devient un conflit et n'insère rien.

## Frontière de sécurité

Cette étape n'autorise aucune livraison au client. `delivery_state` reste obligatoirement `NOT_AUTHORIZED`.

Elle ne contient :

- aucun appel Wave;
- aucun jeton;
- aucun PDF officiel;
- aucun courriel;
- aucun paiement;
- aucun changement du brouillon source;
- aucun branchement dans `app.js`.

Les tests utilisent seulement PostgreSQL jetable et des identifiants synthétiques.
