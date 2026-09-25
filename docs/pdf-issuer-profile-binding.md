# Liaison immuable PDF ↔ profil émetteur vérifié

Cette étape ferme la chaîne documentaire entre une facture `ISSUED_CONFIRMED`, son PDF archivé et l’identité légale/fiscale vérifiée utilisée pour le rendu.

## Règle

Un PDF officiel archivé n’est valide dans cette pile que s’il est lié, dans la même transaction, à **une version précise et déjà vérifiée** du profil émetteur.

Le document conserve :

- `issuer_profile_version_id`;
- le `profile_hash` SHA-256;
- un snapshot JSON immuable du profil vérifié;
- les octets PDF exacts et leur propre SHA-256.

Le PDF imprime également la version et le hash du profil émetteur.

## Pourquoi le snapshot est nécessaire

Les profils émetteur sont versionnés. Si l’adresse, le nom commercial ou un identifiant fiscal change plus tard, une nouvelle version est créée puis vérifiée.

Cette nouvelle version ne modifie jamais :

- le PDF déjà archivé;
- le binding existant;
- le hash du profil utilisé;
- le snapshot d’identité associé à l’ancienne facture.

Il est donc toujours possible de déterminer quelle identité a servi à produire chaque document.

## Transaction et idempotence

Lors d’une première matérialisation :

1. la facture doit être `ISSUED_CONFIRMED`;
2. la facture doit rester `delivery_state = NOT_AUTHORIZED`;
3. la version de profil demandée doit avoir une vérification OWNER persistée;
4. le PDF est rendu avec cette version;
5. l’archive PDF est créée;
6. le binding profil ↔ PDF est créé dans la même transaction.

Un échec du binding annule aussi la création du document.

Un second appel avec la même facture et la même version vérifiée retourne la même archive. Une version différente, un hash différent ou des octets différents produit `DOCUMENT_CONFLICT`; l’ancien document n’est jamais remplacé.

## Immutabilité

`facturations_issued_invoice_document_issuer_bindings` est append-only : UPDATE et DELETE sont interdits.

Une archive PDF sans binding vérifié n’est pas retournée par le store comme document complet.

## Frontière de livraison

Cette étape ne modifie aucun état de livraison :

- facture : `NOT_AUTHORIZED`;
- PDF : `NOT_AUTHORIZED`;
- aucun courriel;
- aucun téléchargement client;
- aucun paiement;
- aucune écriture Wave;
- aucune route ajoutée à `app.js`.

La prochaine étape doit créer une autorisation de livraison indépendante plutôt que déduire l’autorisation du simple fait qu’un PDF existe.
