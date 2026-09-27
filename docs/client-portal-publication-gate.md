# Autorisation de publication au portail client

Une facture émise n’est pas automatiquement visible dans le portail.

Un OWNER doit autoriser séparément la publication d’un PDF qualifié exact avec la confirmation :

`AUTHORIZE_CLIENT_PORTAL_PUBLICATION`

L’autorisation fige :

- la facture émise;
- le PDF qualifié;
- son SHA-256;
- le client propriétaire;
- l’OWNER autorisant;
- l’horodatage.

Le lien client → facture est dérivé du brouillon source immuable et non d’un paramètre fourni par le client.

## Révocation

Une publication peut être retirée avec un second événement append-only :

`REVOKE_CLIENT_PORTAL_PUBLICATION`

La révocation exige un OWNER authentifié et un `reasonCode` explicite. Elle ne modifie ni ne supprime l’autorisation historique.

Le futur read-model du portail doit exclure toute publication révoquée.

## Frontière

Cette brique :

- n’ajoute aucune route publique;
- ne donne aucun accès par numéro de facture;
- n’envoie aucun email;
- ne modifie aucun PDF;
- ne modifie aucun paiement;
- ne publie rien tant qu’un read-model authentifié n’existe pas.
