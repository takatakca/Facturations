# Backup / restore certification drill

Cette preuve CI démontre qu'une base Facturations **jetable et synthétique** peut être sauvegardée, chiffrée, déchiffrée et restaurée dans une deuxième base vide.

## Ce que le workflow fait

Le workflow `Encrypted backup restore drill` :

1. démarre PostgreSQL 16;
2. applique les migrations 001–026 à `facturations_test`;
3. insère une preuve synthétique `example.test`;
4. produit un dump PostgreSQL custom avec `pg_dump`;
5. calcule son SHA-256;
6. chiffre le dump avec AES-256-CBC + PBKDF2;
7. supprime le dump clair;
8. déchiffre dans un nouveau fichier;
9. vérifie que le SHA-256 déchiffré correspond exactement au dump source;
10. crée `facturations_restore_test`;
11. restaure avec `pg_restore --exit-on-error`;
12. vérifie les données synthétiques, tables critiques, vues, triggers append-only, contrainte UNIQUE et FK.

Le workflow utilise les binaires PostgreSQL **16 dans le conteneur PostgreSQL 16**, afin d'éviter une divergence de version entre client et serveur.

## Protections anti-erreur

Les scripts Node refusent de fonctionner si :

- l'hôte DB n'est pas `localhost` / `127.0.0.1`;
- la DB source n'est pas exactement `facturations_test`;
- la DB de destination n'est pas exactement `facturations_restore_test`;
- `FACTURATIONS_DATABASE_URL` est définie.

Aucune donnée réelle ou URL de production n'est nécessaire.

## Ce que cette preuve établit

Elle prouve automatiquement que :

- le schéma migré peut être dumpé;
- le dump peut passer dans un pipeline de chiffrement/déchiffrement sans altération;
- une nouvelle base vide peut être restaurée;
- des données synthétiques survivent;
- plusieurs objets critiques et protections DB survivent au restore.

## Ce que cette preuve ne remplace pas

La CI **ne constitue pas encore la preuve de restauration de production**.

Avant go-live, il faudra définir et tester sur le staging réel :

- emplacement de backup privé;
- chiffrement avec clé/secrets privés ou KMS, jamais une passphrase dans le dépôt;
- rotation des clés;
- fréquence et rétention;
- RPO/RTO acceptés;
- restauration dans une infrastructure isolée;
- contrôle d'accès aux dumps;
- journal/preuve horodatée du drill;
- procédure de destruction sécurisée des copies temporaires.

La passphrase du workflow GitHub est volontairement publique et synthétique parce que la base du drill ne contient que des fixtures fictives. Elle ne doit jamais être réutilisée hors CI.
