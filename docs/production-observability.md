# Observabilité de production — contrat redacted

Facturations émet des événements JSON structurés conçus pour être consommés par le collecteur de logs de l’hébergement sans imposer un fournisseur SaaS particulier.

## Corrélation HTTP

Chaque requête reçoit un `X-Request-ID` généré par le serveur.

Le log `http_request` contient uniquement :

- request ID;
- méthode HTTP;
- **template de route**;
- code HTTP;
- durée en millisecondes;
- composant;
- état terminé/abandonné.

Les query strings ne sont jamais journalisées. Les UUID/IDs dynamiques sont remplacés par `:id`. Une route inconnue devient simplement `/other`.

Le code ne journalise pas :

- nom ou courriel client;
- corps de requête/réponse;
- token magic-link;
- cookie/session;
- Authorization/X-Admin-Key;
- IP;
- User-Agent;
- chaîne PostgreSQL;
- token Wave;
- PDF ou contenu de facture.

Le logger accepte uniquement une liste fermée de champs. Un champ non autorisé est ignoré.

## Événements opérationnels

Événements initiaux :

- `service_listening`;
- `http_request`;
- `database_pool_error`.

Une erreur pool PostgreSQL est journalisée seulement comme code générique `POOL_ERROR`; le message driver et la chaîne de connexion ne sont jamais exposés.

## Seuils initiaux à configurer sur staging

Ces seuils sont des **points de départ à mesurer**, pas un SLA de production :

- **CRITICAL** : `/ready` retourne 503 deux contrôles consécutifs;
- **CRITICAL** : tout `database_pool_error`;
- **HIGH** : taux HTTP 5xx > 5 % sur 5 minutes, avec au moins 20 requêtes;
- **HIGH** : p95 de `durationMs` > 1 000 ms sur 10 minutes, avec au moins 50 requêtes;
- **WARN** : hausse anormale des 401/403 sur 5 minutes, seuil à calibrer pendant le staging;
- **WARN** : redémarrage `service_listening` inattendu hors fenêtre de déploiement.

Le staging doit d’abord établir une baseline avant de resserrer les seuils.

## Rétention et accès

Avant production réelle :

- logs dans un stockage privé;
- accès limité aux opérateurs autorisés;
- chiffrement au repos fourni/validé par l’hébergement;
- rétention documentée;
- export/suppression conformes à la politique de confidentialité retenue;
- test de recherche par `X-Request-ID`;
- preuve qu’aucun secret ou PII n’apparaît dans un échantillon de logs staging.

## Limite

Cette brique fournit le contrat applicatif et des logs machine-readable. Elle ne prétend pas qu’un collecteur, une alerte ou une astreinte externe est déjà configuré. Cette preuve doit être réalisée sur le staging réel.
