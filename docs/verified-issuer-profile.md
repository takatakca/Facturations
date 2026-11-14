# Profil légal/fiscal émetteur versionné et vérifié

Cette brique crée une source de vérité interne pour l’identité de l’émetteur qui pourra être figée dans les futurs PDF et livraisons.

Aucune vraie donnée d’entreprise n’est ajoutée au dépôt par défaut.

## Deux actes séparés

1. **Créer une version** avec la confirmation exacte `CREATE_ISSUER_PROFILE_VERSION`.
2. **Vérifier cette version pour la facturation** avec la confirmation exacte `VERIFY_ISSUER_PROFILE_FOR_INVOICING`.

Les deux opérations exigent une session OWNER valide et vérifiée.

Une version non vérifiée ne doit jamais être utilisée comme identité officielle dans une facture livrable.

## Données d’une version

Chaque version conserve :

- nom légal;
- nom commercial facultatif;
- adresse;
- ville, région, code postal, pays;
- courriel;
- téléphone facultatif;
- numéro d’enregistrement d’entreprise facultatif;
- identifiants fiscaux sous forme d’objet clé/valeur;
- hash SHA-256 canonique du profil;
- OWNER créateur;
- numéro de version;
- date de création.

Les identifiants fiscaux ne sont pas inventés ni validés contre une autorité externe par ce module. La vérification OWNER signifie uniquement qu’un humain autorisé confirme les données saisies pour le flux de facturation.

## Immutabilité

`facturations_issuer_profile_versions` et `facturations_issuer_profile_verifications` sont append-only. UPDATE et DELETE sont refusés par trigger.

Une correction ne modifie donc jamais l’ancienne version : elle crée une nouvelle version, qui doit ensuite être vérifiée séparément.

## Sélection

`getLatestVerified()` retourne la version vérifiée ayant le plus grand numéro de version.

Une nouvelle version non vérifiée ne remplace pas la dernière version vérifiée.

`getVerifiedById()` permet de relire précisément une version vérifiée afin qu’une future archive PDF puisse conserver son ID et son hash.

## Frontière actuelle

Cette PR ne modifie pas encore le PDF de la PR #85. Elle prépare la source de vérité nécessaire pour une prochaine étape où le document devra référencer explicitement une version vérifiée.

Aucun courriel, téléchargement client, paiement ou appel Wave n’est ajouté.
