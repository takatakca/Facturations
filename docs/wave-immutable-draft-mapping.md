# Mapping strict snapshot immuable → Wave

Ce module transforme uniquement un brouillon immuable `DRAFT` déjà calculé en entrée `InvoiceCreateInput`, sans réseau.

Règles de sécurité :

- un `productId` Wave explicite est requis pour chaque ligne;
- chaque taxe interne exige un profil Wave explicite avec même code et même taux;
- les taxes composées sont refusées dans ce lot;
- les rabais par ligne sont refusés au lieu d'être convertis approximativement;
- sous-total, taxes et total du snapshot sont revérifiés avant construction du payload;
- aucun numéro de facture n'est créé localement;
- le résultat est encore validé par le contrat Wave pur.

La documentation Wave actuelle indique que `InvoiceCreateInput.discounts` est limité à un rabais au niveau facture et que les taxes de lignes utilisent `salesTaxId`. Le live devra donc charger/valider les vrais profils client/produit/taxe depuis Wave avant toute mutation.

Aucun token, réseau, appel Wave, facture officielle, PDF, courriel ou paiement.
