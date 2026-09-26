# Provenance émetteur et PDF qualifié

Cette brique relie une facture locale déjà `ISSUED_CONFIRMED` à une version exacte d’un profil émetteur `VERIFIED`, puis produit un PDF qualifié immuable.

## Liaison facture → profil

La liaison exige :

- un OWNER actif/authentifié;
- une facture `ISSUED_CONFIRMED`;
- `delivery_state = NOT_AUTHORIZED`;
- un profil émetteur `VERIFIED`;
- la confirmation exacte `BIND_VERIFIED_ISSUER_TO_INVOICE`.

La liaison fige :

- l’ID de facture;
- l’ID de profil;
- le hash du profil;
- la version du profil;
- l’OWNER ayant effectué la liaison;
- la date de liaison.

Une facture ne peut être liée qu’une seule fois. Une nouvelle version du profil ne modifie jamais les factures déjà liées.

## PDF qualifié

Le PDF qualifié exige la chaîne complète :

1. facture `ISSUED_CONFIRMED`;
2. archive PDF de base de la migration 014;
3. liaison émetteur immuable;
4. profil `VERIFIED`;
5. correspondance exacte ID/version/hash.

Le PDF qualifié archive aussi :

- l’ID et le SHA-256 du PDF source;
- l’ID/version/hash du profil;
- son propre SHA-256;
- les octets PDF;
- `delivery_state = NOT_AUTHORIZED`.

Le rendu ajoute au document :

- nom légal;
- nom d’affichage;
- adresse;
- contacts;
- registrations fiscales explicitement enregistrées;
- version et hash SHA-256 du profil.

## Barrière fiscale minimale

Si la facture contient un montant de taxes supérieur à zéro et que le profil ne contient aucune registration fiscale, la génération est bloquée avec `TAX_REGISTRATION_EVIDENCE_REQUIRED`.

Cette barrière ne prétend pas déterminer automatiquement quel numéro réglementaire correspond à quel code de taxe. Une politique fiscale/comptable explicite reste requise avant production.

## Livraison toujours interdite

Même un PDF qualifié conserve `delivery_state = NOT_AUTHORIZED`.

Cette étape n’ajoute :

- aucune route publique;
- aucun courriel;
- aucun paiement;
- aucun appel Wave;
- aucune autorisation de livraison.

La prochaine étape doit créer une autorisation de livraison OWNER séparée qui ne peut référencer qu’un PDF qualifié immuable.
