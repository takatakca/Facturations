# Autorisation OWNER de livraison d’un PDF

Cette étape sépare explicitement **l’existence d’une facture/PDF** de la permission de l’envoyer au client.

Une facture `ISSUED_CONFIRMED` et son PDF archivé restent tous deux `delivery_state = NOT_AUTHORIZED`. L’autorisation est enregistrée dans un registre séparé.

## Confirmation exigée

L’OWNER doit fournir la confirmation exacte :

`AUTHORIZE_EMAIL_DELIVERY`

et reconfirmer les éléments qui seront utilisés par une future tentative d’envoi :

- le document exact;
- le canal `EMAIL`;
- le courriel destinataire;
- le numéro officiel;
- le SHA-256 du PDF;
- le SHA-256 du profil émetteur.

Ces valeurs sont comparées à la chaîne immuable :

PDF → facture émise → snapshot client → binding émetteur → profil vérifié.

Toute divergence produit un conflit et aucune autorisation n’est créée.

## État

Une autorisation réussie crée uniquement :

`AUTHORIZED_NOT_SENT`

Cela signifie qu’un OWNER a autorisé **ce document précis** pour **ce destinataire précis**.

Cela ne signifie pas :

- que le courriel a été préparé;
- qu’un fournisseur SMTP/API a été contacté;
- que le message a été accepté;
- que le client l’a reçu;
- qu’un paiement a été demandé.

## Immutabilité et idempotence

`facturations_document_delivery_authorizations` est append-only.

Une seule autorisation existe par document. Rejouer la même confirmation retourne le même enregistrement. Une divergence sur le document, le destinataire, le numéro, le SHA-256 ou le profil devient un conflit.

La facture et le PDF source ne sont pas modifiés; leur `delivery_state` reste `NOT_AUTHORIZED`. La permission de livraison existe uniquement dans ce registre séparé.

## Étape suivante

La prochaine brique pourra créer une **tentative de livraison persistante** à partir de `AUTHORIZED_NOT_SENT`, avec une machine d’état séparée et des résultats ambigus bloquant tout retry automatique.

Cette page n’autorise aucun envoi réel.
