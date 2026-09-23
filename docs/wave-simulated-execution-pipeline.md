# Exécution Wave simulée — chaîne vérifiée complète

Le pipeline n'accepte plus ni brouillon, ni payload Wave, ni token fournis à l'exécution.

Ordre actuel :

1. recevoir seulement l'identifiant d'autorisation, la clé de tentative et les IDs externes à vérifier;
2. appeler le resolver Wave lecture seule;
3. vérifier client, produits et taxes contre le snapshot immuable autorisé;
4. recharger le même snapshot depuis PostgreSQL;
5. construire le mapping strict snapshot → `InvoiceCreateInput`;
6. valider le contrat Wave;
7. ouvrir la tentative fournisseur idempotente;
8. classer une réponse de transport simulée;
9. persister le résultat ou imposer une réconciliation en cas d'ambiguïté.

Une divergence entre le draft résolu et le draft rechargé arrête la chaîne avant toute tentative.

## Limite volontaire

La dernière étape est encore **simulée** : aucun POST GraphQL d'écriture n'est effectué. Avant d'activer une vraie mutation, il faut un compte Wave de test autorisé, exécuter les lectures réelles, comparer le payload final, puis tester création/réconciliation sans client réel.

Aucun courriel, PDF officiel, paiement ou émission locale.
