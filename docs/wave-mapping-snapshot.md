# Snapshot de mappings Wave — préparation sans réseau

Cette étape persiste les identifiants Wave nécessaires à une future émission **sans appeler l’API Wave**.

## Portée

Un mapping est lié à une autorisation d’émission précise et à son brouillon immuable. Il contient :

- l’identifiant Wave de l’entreprise;
- l’identifiant Wave du client;
- un identifiant Wave de produit/service pour chaque ligne du brouillon;
- les identifiants Wave de taxes correspondant exactement aux codes et taux enregistrés.

Le plan est recalculé à partir du snapshot immuable avant d’être accepté. Son hash SHA-256 est enregistré avec le mapping.

## Règles

- une autorisation ne peut avoir qu’un seul snapshot de mapping;
- répéter exactement le même mapping est idempotent;
- changer le client, un produit, une taxe ou le hash après la première sauvegarde provoque un conflit;
- un taux Wave différent du taux du snapshot est refusé;
- les rabais par ligne restent refusés parce que le mapping actuel ne peut pas préserver cette sémantique sans approximation;
- aucun ID fournisseur n’est déduit d’un nom ou d’un courriel;
- aucun appel Wave n’est effectué par ce store.

## Pourquoi

Le futur adaptateur d’émission ne doit jamais accepter des IDs Wave libres au moment de l’appel externe. Il devra charger ce snapshot persistant, vérifier son hash, puis créer ou réconcilier une tentative fournisseur via le moteur d’état de la migration 012.

Migration : `db/013_wave_mapping_snapshot.sql`.
Store : `src/wave-mapping-store.js`.
Préflight local : `src/wave-issuance-preflight.js`.
