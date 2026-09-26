# Ledger append-only des preuves fournisseur courriel

Cette brique persiste les preuves de fournisseur selon le contrat de la PR précédente.

## Modes de source

Le schéma connaît deux modes :

- `SYNTHETIC_TEST`;
- `SIGNED_WEBHOOK`.

**Le code actuel n’écrit que `SYNTHETIC_TEST`.** Aucun code de webhook signé n’existe encore.

Cette séparation empêche qu’un événement de test soit présenté comme une preuve réelle.

## Événements

Le ledger accepte seulement :

- `DELIVERED`;
- `BOUNCED`;
- `COMPLAINT`.

`ACCEPTED` reste un résultat de soumission API et n’est pas un événement de preuve de livraison.

Chaque ligne conserve :

- PDF qualifié et SHA-256 exact;
- clé d’opération;
- provider key;
- message ID;
- event ID;
- type;
- timestamp fournisseur;
- destinataire;
- mode de source;
- SHA-256 canonique de la preuve.

## Vérifications

L’ingestion synthétique :

1. normalise l’événement via le contrat fournisseur;
2. exige le provider key configuré;
3. charge le PDF qualifié tenant-scoped;
4. exige une facture source `ISSUED_CONFIRMED`;
5. exige que le PDF reste `NOT_AUTHORIZED`;
6. vérifie le destinataire contre le snapshot immuable;
7. persiste l’événement idempotemment.

Un même event ID avec contenu divergent devient un conflit.

## Immutabilité

Le ledger est append-only. UPDATE et DELETE sont bloqués par trigger PostgreSQL.

Plusieurs événements peuvent exister pour le même message. Aucune hiérarchie artificielle n’est imposée : un système de synthèse futur devra interpréter la chronologie et le type d’événement explicitement.

## Frontière

Cette étape :

- n’expose aucun webhook;
- ne vérifie aucune signature réelle;
- ne contacte aucun fournisseur;
- n’envoie aucun courriel;
- ne marque rien comme réellement livré;
- ne modifie aucun `delivery_state`.

La prochaine étape pourra créer une vue de synthèse de statut à partir du ledger, sans supprimer ni réécrire les événements.
