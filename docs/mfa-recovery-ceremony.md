# Cérémonie de récupération MFA OWNER

La récupération MFA est une opération d’administration **hors navigateur**. Elle n’est pas exposée par une route HTTP et ne doit jamais être accessible au rôle PostgreSQL runtime de l’application.

## Autorisation

Une récupération peut être émise uniquement pour un compte :

- `OWNER`;
- actif;
- avec courriel déjà vérifié.

L’opérateur doit fournir :

- `confirmation = AUTHORIZE_OWNER_MFA_RECOVERY`;
- `verificationMethod = HUMAN_OUT_OF_BAND`;
- une référence non secrète de la vérification humaine.

Le token de récupération :

- contient 256 bits aléatoires;
- est stocké uniquement en SHA-256;
- expire après 30 minutes;
- n’est retourné en clair qu’une seule fois;
- ne doit jamais être placé dans un URL, log, ticket ou dépôt.

Une nouvelle autorisation révoque toute autorisation précédente encore active.

## Redemption

La redemption exige simultanément :

1. le token de récupération valide;
2. le mot de passe OWNER actuel.

Une redemption réussie, dans une transaction PostgreSQL unique :

- remplace le secret TOTP chiffré;
- remet le nouveau TOTP en état non activé;
- révoque toutes les sessions OWNER actives;
- consomme définitivement l’autorisation;
- retourne le nouveau secret Base32 une seule fois.

Le nouveau secret doit ensuite être ajouté à l’application d’authentification et confirmé avec `confirmTrusted()` avant qu’une nouvelle connexion MFA soit possible.

## Propriétés de sécurité

- redemption concurrente : une seule réussite;
- token révoqué/expiré/consommé : refus;
- mauvais mot de passe : aucune rotation, aucune révocation de session;
- ancien TOTP : invalide immédiatement après la rotation;
- ancien cookie de session : révoqué;
- aucune récupération pour un rôle STAFF;
- autorisations et événements : append-only;
- runtime Node : aucun droit SQL sur les tables de récupération;
- runtime Node : aucune permission d’UPDATE sur les colonnes secrètes TOTP.

## Séparation des rôles PostgreSQL

Le rôle applicatif runtime ne peut ni émettre ni consommer une récupération.

En staging/production, la cérémonie doit utiliser une identité PostgreSQL d’opération dédiée ou un mécanisme administrateur contrôlé donnant uniquement les droits nécessaires à cette opération. Ne pas réutiliser le compte runtime Node.

## Homologation staging

Le gate `mfa_recovery_drill` reste `REAL_STAGING`.

Il ne devient PASS qu’après un drill réel sur un compte OWNER fictif du staging démontrant :

- vérification d’identité documentée;
- émission du token sans fuite dans les logs;
- révocation/reissue;
- mauvais mot de passe sans effet;
- rotation réussie;
- sessions antérieures révoquées;
- ancien TOTP rejeté;
- nouveau TOTP activé;
- nouvelle connexion réussie;
- preuve audit conservée sans secret.
