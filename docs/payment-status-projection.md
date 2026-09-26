# Projection financière lecture seule

La vue `facturations_payment_evidence_summary` synthétise le ledger financier append-only sans modifier les événements bruts.

Pour chaque facture `ISSUED_CONFIRMED`, elle expose :

- total de facture;
- paiements observés;
- remboursements observés;
- net payé;
- solde;
- nombre de preuves;
- présence de paiement/remboursement;
- présence éventuelle d’une preuve provider vérifiée;
- premier/dernier timestamp de preuve.

## États dérivés

- `NO_EVIDENCE`
- `UNPAID`
- `PARTIALLY_PAID`
- `PAID`
- `OVERPAID`
- `FULLY_REFUNDED`
- `REFUND_EXCEEDS_PAYMENTS`

La projection ne supprime aucun fait. Un remboursement après paiement reste visible dans les totaux et l’état est recalculé à partir du ledger complet.

## Portée de preuve

- `NONE`
- `SYNTHETIC_ONLY`
- `VERIFIED_PROVIDER_PRESENT`

Tant que le ledger n’ingère que `SYNTHETIC_TEST`, aucune projection n’est présentée comme preuve de paiement réelle.

La vue ne débite, ne rembourse et ne contacte aucun provider.
