# Tentatives persistantes de livraison

Cette brique intervient après l’autorisation OWNER de livraison de la migration 017. Elle ne contacte aucun fournisseur de courriel réel.

## Machine d’état

Chaque autorisation produit au plus une tentative :

`PREPARED → IN_PROGRESS → CONFIRMED / FAILED / AMBIGUOUS`

Le fournisseur actuel est explicitement `SIMULATED_EMAIL`.

La clé d’opération est stable et dérivée de :

- l’entreprise;
- l’ID d’autorisation;
- le SHA-256 du PDF qualifié;
- le SHA-256 du snapshot de destination.

## Résultat ambigu

Une exception adapter, un résultat invalide ou un résultat explicitement ambigu place la tentative en `AMBIGUOUS`.

À partir de cet état :

- aucun nouvel appel adapter automatique n’est permis;
- un deuxième `execute()` échoue avec `AMBIGUOUS_REQUIRES_RECONCILIATION`;
- seule une réconciliation explicite peut terminer en `CONFIRMED` ou `FAILED`.

Cela évite un double envoi après timeout ou réponse fournisseur incertaine.

## Journal

Chaque transition est persistée dans `facturations_delivery_events`, append-only :

- création `PREPARED`;
- démarrage adapter;
- confirmation;
- échec;
- ambiguïté;
- réconciliation.

Les événements ne peuvent pas être modifiés ou supprimés.

## Frontière

Un état `CONFIRMED` dans cette brique signifie seulement que l’adapter injecté a confirmé son résultat. Tant que l’adapter est `SIMULATED_EMAIL`, cela ne prouve aucun envoi réel.

Cette étape :

- ne configure aucun SMTP/API;
- ne possède aucune clé de fournisseur;
- ne change pas les `delivery_state` des documents;
- ne contacte pas le client;
- ne crée aucun paiement;
- ne modifie pas Wave;
- n’ajoute aucune route publique.

Avant tout fournisseur réel, il faudra une configuration de staging isolée, des identifiants de test, une politique de retry/reconciliation et une validation explicite du fournisseur retenu.
