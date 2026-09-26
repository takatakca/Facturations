# Ledger de preuves de paiement et remboursement

Cette brique ajoute un journal financier append-only lié à une facture locale `ISSUED_CONFIRMED`.

## Événements

Deux types sont pris en charge :

- `PAYMENT_RECEIVED`
- `REFUND_ISSUED`

Chaque événement conserve :

- la facture émise;
- la clé du fournisseur;
- l’ID d’événement provider;
- l’ID de transaction provider;
- le type;
- le montant en cents;
- `currency = CAD`;
- le timestamp provider;
- le mode de preuve;
- un SHA-256 canonique.

## Portée actuelle

Le store public actuel n’accepte que `SYNTHETIC_TEST`.

`VERIFIED_PROVIDER_WEBHOOK` est réservé au schéma pour une intégration future qui devra être précédée d’une vérification cryptographique/provider-specific séparée.

Il n’existe volontairement aucune méthode permettant de déclarer arbitrairement une preuve réelle.

## Sécurité

- aucune donnée de carte;
- aucun débit;
- aucun remboursement;
- aucune clé de processeur;
- aucune API externe;
- aucun webhook public;
- tenant scoping sur chaque requête;
- idempotence par provider + event ID;
- event ID divergent => conflit;
- UPDATE/DELETE interdits.

Le ledger conserve les faits bruts. Une projection séparée calculera ensuite payé, remboursé, net et solde sans réécrire l’historique.
