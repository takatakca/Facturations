# Exécution Wave simulée — autorisation + snapshot + contrat + état fournisseur

Ce pipeline relie désormais l'autorisation persistée au **snapshot immuable PostgreSQL** avant de construire le contrat `invoiceCreate`. Il n'accepte plus de payload Wave brut ni de draft fourni par l'appelant.

Ordre de traitement :

1. charger l'autorisation et le brouillon immuable liés dans la base dédiée;
2. vérifier que le total et le destinataire correspondent toujours à l'autorisation;
3. construire le mapping Wave strict du snapshot;
4. valider entièrement `InvoiceCreateInput`;
5. ouvrir seulement ensuite une tentative fournisseur idempotente;
6. classer une réponse de transport **simulée**;
7. enregistrer `CONFIRMED`, `AMBIGUOUS`, `FAILED_RETRYABLE` ou `FAILED_FINAL`.

Un mapping invalide échoue avant `beginAttempt`. Le store recharge aussi l'autorisation dans `beginAttempt`; les liens autorisation → draft et les snapshots sont immuables.

## Frontière restante

Les identifiants Wave `businessId`, `customerId`, `productIds` et profils de taxes sont encore fournis par une couche de mapping explicite. Le prochain lot doit les résoudre depuis des données Wave **en lecture vérifiée** et empêcher une mutation si le client, le produit, le taux ou le type de taxe ne concorde pas.

Aucun token, réseau, appel Wave, facture réelle, PDF officiel, courriel ou paiement.
