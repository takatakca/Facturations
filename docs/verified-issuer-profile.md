# Profil émetteur légal/fiscal vérifié

Cette brique crée une source de vérité locale, versionnée et append-only pour l’identité de l’émetteur utilisée par les futurs documents officiels.

Aucune donnée légale ou fiscale n’est inventée, déduite d’un domaine, tirée de Wave ou copiée depuis une variable d’environnement. Un profil n’existe qu’après une confirmation OWNER explicite.

## Création

`createIssuerProfileStore(...).createVerified()` exige :

- un OWNER actif et authentifié;
- `confirmation = VERIFY_ISSUER_PROFILE`;
- `verificationMethod = HUMAN_DOCUMENT_REVIEW`;
- une référence de vérification interne;
- le nom légal;
- le nom d’affichage;
- 1 à 3 lignes d’adresse;
- ville, région, code postal et pays ISO alpha-2;
- courriel/téléphone facultatifs;
- une liste explicite de registrations fiscales, chacune composée d’un `scheme` et d’un `registrationNumber`.

La validation ne prétend pas certifier le format réglementaire d’un numéro fiscal. La vérification humaine reste la source de confiance.

Avant qu’un profil puisse devenir `VERIFIED`, tous les champs qui apparaîtront dans le PDF officiel sont aussi vérifiés contre l’encodage WinAnsi du renderer v1. Un caractère non représentable retourne `ISSUER_PROFILE_PDF_TEXT_UNSUPPORTED` (409). Cela empêche de lier après émission un profil que Facturations serait incapable d’archiver correctement dans son PDF qualifié actuel.

## Versioning

Chaque entreprise possède des versions 1, 2, 3… protégées par verrou transactionnel tenant-scoped.

Le contenu normalisé du profil produit un SHA-256 stable.

- même contenu + même preuve OWNER => retour de la version existante;
- même contenu avec une preuve différente => conflit;
- contenu modifié => nouvelle version;
- aucune version existante n’est mise à jour.

## Immutabilité

La migration 015 crée `facturations_issuer_profiles`.

Un trigger PostgreSQL bloque tout `UPDATE` et `DELETE`. Les documents futurs devront référencer l’ID exact du profil utilisé, et non simplement “le profil courant”.

## Frontière

Le profil vérifié est désormais lié par ID/hash au PDF qualifié et ses données sont rendues dans le document. Un document taxable reste bloqué si la chaîne qualifiée ne contient pas la preuve fiscale exigée par la politique actuelle.

Cette brique ne contacte aucune API externe et ne remplace pas la validation comptable/fiscale humaine. Les formats réglementaires, registrations et mentions obligatoires doivent encore être homologués avant production.
