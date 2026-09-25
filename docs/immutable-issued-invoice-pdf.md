# PDF immuable d’une facture émise

Cette brique commence uniquement après qu’une facture locale existe déjà dans `facturations_issued_invoices` avec :

- `status = ISSUED_CONFIRMED`;
- `delivery_state = NOT_AUTHORIZED`.

Elle produit un PDF bilingue FR/EN, calcule son SHA-256 et stocke les octets exacts dans PostgreSQL. Elle ne livre pas le document au client.

## Source de vérité

Le PDF est rendu uniquement depuis le snapshot immuable déjà matérialisé avec la facture émise, plus :

- le numéro officiel;
- l’identifiant fournisseur Wave;
- la date de confirmation fournisseur.

Avant rendu, les montants, lignes et taxes sont recalculés avec `previewDraft()` et comparés aux valeurs du snapshot. Une divergence bloque la génération.

## Immutabilité et idempotence

La migration 014 ajoute `facturations_issued_invoice_documents`.

Un document conserve :

- l’ID de facture émise;
- `document_kind = INVOICE_PDF`;
- la version exacte du moteur de rendu;
- `content_type = application/pdf`;
- le SHA-256 du contenu;
- la taille exacte;
- les octets PDF (`bytea`);
- `delivery_state = NOT_AUTHORIZED`;
- la date de création.

Un trigger interdit UPDATE et DELETE. Une seule archive PDF peut exister par facture émise.

Relancer la génération avec les mêmes octets retourne le même document. Si le rendu produit des octets différents pour la même facture, l’opération échoue avec un conflit au lieu de remplacer l’archive.

## Rendu v1

`src/official-invoice-pdf.js` génère un PDF 1.4 déterministe, multipage, avec les polices standard PDF Helvetica/Courier et l’encodage WinAnsi.

Les caractères français courants et la ponctuation Windows-1252 sont pris en charge. Un caractère non représentable est refusé avec `UNSUPPORTED_PDF_CHARACTER`; il n’est jamais remplacé silencieusement.

Cette limite est volontaire pour la première version. Avant homologation générale, un moteur avec police Unicode incorporée devra être validé pour les noms/adresses hors WinAnsi.

## Frontière de livraison

Même après archivage :

- la facture émise reste `delivery_state = NOT_AUTHORIZED`;
- le document reste `delivery_state = NOT_AUTHORIZED`;
- aucun courriel n’est envoyé;
- aucune route publique de téléchargement n’est ajoutée;
- aucun paiement n’est initié;
- aucune API Wave n’est appelée;
- aucun changement n’est fait dans `app.js`.

L’autorisation de livraison, le téléchargement privé et l’envoi client constituent des étapes séparées.

## Limite fiscale

Le PDF utilise les données déjà présentes dans le snapshot et le numéro confirmé par le fournisseur. Le lot ne crée pas de profil légal/fiscal de l’émetteur et ne constitue pas une homologation comptable ou fiscale. Les mentions légales, numéros de taxes et identité légale de l’émetteur doivent être validés avant production réelle.
