# Runner Wave simulé — chaîne récente #75 → #76

Ce module relie le mapping Wave persistant de la PR #76 à la machine d’état fournisseur de la PR #75, sans réseau et sans jeton Wave.

## Entrée

Le runner accepte seulement :

- l’identifiant de l’autorisation d’émission;
- l’identifiant du brouillon correspondant.

Il ne reçoit jamais de token, de GraphQL, de customer/product/tax IDs libres ni de payload fournisseur. Le plan `READY_FOR_WAVE_ADAPTER` est rechargé depuis `facturations_wave_issuance_mappings`.

## Adaptateur

L’adaptateur injecté doit annoncer `mode: 'SIMULATED_ONLY'` et fournir deux fonctions :

- `issue({ operationKey, plan })`;
- `reconcile({ operationKey, plan })`.

Un adaptateur marqué réel est refusé par construction dans ce lot.

## Exécution

1. recharger et revérifier le mapping figé;
2. préparer la tentative persistante;
3. passer à `IN_PROGRESS`;
4. appeler l’adaptateur simulé avec la clé d’opération persistante;
5. enregistrer `CONFIRMED`, `FAILED_RETRYABLE`, `FAILED_FINAL` ou `AMBIGUOUS`.

Une exception, une réponse malformée ou une confirmation dont le client/total/taxes divergent du plan est enregistrée comme `AMBIGUOUS`, jamais comme succès.

## Réconciliation

Une tentative `AMBIGUOUS` ne peut pas être relancée. La réconciliation simulée peut produire :

- `FOUND` → `CONFIRMED`, après vérification du client, devise, total et taxes;
- `NOT_FOUND` → `FAILED_RETRYABLE`;
- `FAILED_FINAL` → état terminal;
- `UNKNOWN` ou erreur → aucun changement d’état.

Après `NOT_FOUND`, le retry réutilise la même `operationKey`.

## Limites

Aucun appel Wave réel, aucune facture externe, aucun numéro réel, aucun changement de `invoice_drafts.status`, aucun PDF officiel, courriel, paiement ou déploiement.

Le prochain passage vers un adaptateur Wave réel exige un compte de test autorisé, une lecture réelle vérifiée puis une mutation contrôlée séparément avec réconciliation.
