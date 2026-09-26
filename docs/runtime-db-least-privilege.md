# Rôle PostgreSQL runtime à privilèges minimaux

Facturations doit utiliser deux identités PostgreSQL distinctes :

1. **migration/owner** — utilisée seulement pour appliquer les migrations et les changements de schéma;
2. **runtime** — utilisée par l’application Node pour son fonctionnement normal.

Le rôle runtime ne doit jamais être propriétaire du schéma, des tables, séquences, vues ou fonctions.

## Politique

Le fichier `ops/runtime-db-grants.sql` est appliqué **après** les migrations 001–026 par le rôle de migration.

Il retire les privilèges implicites dangereux sur la base dédiée puis accorde explicitement :

- `CONNECT` à la base;
- `USAGE` sur `public`;
- `SELECT` sur les tables et projections;
- `INSERT` uniquement sur les tables applicatives;
- `UPDATE` seulement sur les tables réellement mutables;
- `DELETE` seulement sur `facturations_login_attempt_limits`;
- `USAGE, SELECT` sur les séquences.

Le runtime ne reçoit pas :

- `CREATE` sur la base ou le schéma;
- `TRUNCATE`;
- `REFERENCES`;
- `TRIGGER`;
- propriété d’objet;
- superuser / createdb / createrole / replication / bypassrls;
- appartenance à un rôle privilégié.

## Vérification

`scripts/verify-runtime-db-privileges.js` compare PostgreSQL à une matrice explicite.

Le check échoue si une nouvelle table ou vue `facturations_*` / `invoice_*` apparaît sans mise à jour explicite de la politique. Une migration future ne reçoit donc jamais des droits runtime automatiquement.

Le script de vérification refuse toute cible autre que la base jetable locale `facturations_test`. L’application de la politique sur staging réel doit être effectuée séparément par l’administrateur de la base, avec les identités et secrets privés de staging.

## Ordre de déploiement

1. le migrateur applique 001–026;
2. le migrateur applique `ops/runtime-db-grants.sql`;
3. l’application démarre avec l’URL du **rôle runtime**, jamais avec l’URL du propriétaire/migrateur;
4. `/ready` vérifie la connectivité runtime;
5. aucune migration n’est exécutée par le processus applicatif.

Cette séparation doit être revalidée après chaque nouvelle migration.
