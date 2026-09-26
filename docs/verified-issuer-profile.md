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

Cette étape ne modifie pas encore un PDF existant, n’envoie rien au client et ne contacte aucune API externe.

Le prochain lot devra :

1. exiger un profil `VERIFIED`;
2. figer son ID/hash dans la provenance du PDF;
3. afficher les données de l’émetteur dans le document;
4. refuser un document taxable si les registrations nécessaires n’ont pas été explicitement validées selon la politique comptable retenue.

La décision comptable/fiscale finale et les mentions obligatoires restent à faire vérifier avant production.
