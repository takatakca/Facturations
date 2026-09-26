# Autorisation OWNER de livraison du PDF qualifié

Cette étape ne livre rien. Elle enregistre uniquement une autorisation immuable qui pourra être consommée plus tard par un moteur de livraison séparé.

## Source obligatoire

L’autorisation exige :

- un OWNER authentifié et actif;
- un PDF qualifié existant;
- une facture source `ISSUED_CONFIRMED`;
- la facture et le PDF qualifié encore en `delivery_state = NOT_AUTHORIZED`;
- la confirmation exacte `AUTHORIZE_QUALIFIED_PDF_DELIVERY`;
- le courriel destinataire retapé explicitement par l’OWNER.

Le courriel attendu est comparé au destinataire figé dans le snapshot de facture. Une différence bloque l’autorisation avec `RECIPIENT_MISMATCH`.

## Provenance figée

L’autorisation conserve :

- l’ID de facture;
- l’ID du PDF qualifié;
- le SHA-256 exact du PDF qualifié;
- le courriel destinataire;
- un SHA-256 du snapshot de destination;
- l’OWNER autorisant;
- la confirmation;
- `state = AUTHORIZED_PENDING_DELIVERY`.

La ligne est append-only et idempotente.

## Frontière de sécurité

Cette autorisation :

- ne modifie pas `delivery_state` du PDF;
- ne modifie pas la facture;
- n’envoie aucun courriel;
- ne contacte aucun fournisseur;
- ne crée aucun paiement;
- n’ajoute aucune route publique.

La prochaine étape devra transformer cette autorisation en une **tentative de livraison persistante** avec états préparé/en cours/confirmé/échoué/ambigu, sur le même principe que l’émission fournisseur.
