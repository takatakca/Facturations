# Fondation d’authentification du portail client

Cette brique ajoute une identité client tenant-scoped et un accès passwordless par lien à usage unique. Elle n’ajoute aucune route HTTP publique.

## Émission du lien

Seul un OWNER actif et authentifié peut produire un lien pour un `customer_id` précis.

Le lien :

- contient 256 bits aléatoires;
- n’est stocké qu’en SHA-256;
- expire après 30 minutes;
- invalide les anciens liens non consommés du même client;
- est lié au courriel courant du répertoire client;
- devient invalide si ce courriel change avant consommation.

## Consommation

La consommation :

- vérifie le token, l’expiration et la non-réutilisation;
- vérifie encore le `business_id`, le `customer_id` et le courriel;
- marque la boîte comme vérifiée;
- consomme le lien;
- révoque les anciennes sessions client;
- crée une session aléatoire hachée de 12 heures.

Le même mécanisme sert à l’activation initiale et à la récupération passwordless.

## Session

Une session n’est valide que si :

- elle appartient au bon tenant;
- elle n’est ni expirée ni révoquée;
- le compte portail est actif et vérifié;
- son courriel vérifié correspond toujours au courriel courant du client.

Un changement de courriel empêche donc immédiatement une ancienne session d’être acceptée.

## Frontière

Aucune page publique, aucun email réel et aucun endpoint d’auto-demande de lien ne sont ajoutés. La remise sécurisée du lien à la boîte prévue reste une étape séparée dépendant d’un fournisseur courriel homologué.
