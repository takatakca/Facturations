# Exécution Wave simulée — contrat + état fournisseur

Ce lot relie le contrat pur `invoiceCreate` au store d'exécution fournisseur, **sans réseau et sans jeton**.

Le pipeline :
1. valide entièrement le payload Wave avant d'ouvrir une tentative persistante;
2. ouvre une tentative via le store idempotent;
3. classe une réponse de transport **simulée**;
4. enregistre `CONFIRMED`, `AMBIGUOUS`, `FAILED_RETRYABLE` ou `FAILED_FINAL`;
5. ne modifie jamais le statut local `DRAFT` et n'envoie rien.

Une réponse ambiguë continue d'être soumise aux règles de réconciliation de la PR fournisseur précédente. Un payload Wave invalide échoue avant la création de la tentative.

## Limite volontaire

Le pipeline ne prouve pas encore que les identifiants Wave fournis correspondent au client, aux produits et aux taxes du snapshot immuable. Le prochain lot doit construire ce **mapping snapshot → Wave** et refuser toute approximation, notamment les rabais par ligne tant que leur équivalence Wave exacte n'est pas démontrée.

Aucun compte Wave, aucun token, aucun appel HTTP, aucune facture réelle, aucun courriel et aucun paiement.
