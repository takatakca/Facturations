# Résolution Wave en lecture seule

Ce module utilise uniquement des requêtes GraphQL **fixes** vers Wave :

- client par `businessId + customerId`;
- produit par `businessId + productId`;
- taxe par `businessId + salesTaxId + date`.

Aucune opération GraphQL n'est fournie par l'appelant et aucune mutation n'est présente dans ces requêtes.

Les réponses sont bornées, validées et tenant-scoped. Le taux de taxe Wave est converti vers le modèle interne en milli-pourcentage uniquement s'il est représentable exactement; sinon le mapping est refusé.

Le prochain resolver métier devra comparer :
- courriel/currency du client au snapshot autorisé;
- produit vendu et non archivé;
- taxe non archivée, non composée, code et taux exacts.

Les tests utilisent un `fetch` synthétique : aucun jeton ni compte Wave réel n'est utilisé.
