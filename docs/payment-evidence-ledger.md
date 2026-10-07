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

Le store accepte `SYNTHETIC_TEST` et, depuis la migration 046, `VERIFIED_PROVIDER_WEBHOOK` uniquement pour un webhook Stripe dont la signature a été vérifiée par Facturations (`ingestVerifiedStripe()`, provenance SHA-256 + `STRIPE_SIGNATURE_V1` imposée par PostgreSQL). Voir [`stripe-verified-payment-webhook.md`](stripe-verified-payment-webhook.md).

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
