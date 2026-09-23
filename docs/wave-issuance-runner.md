# Runner Wave simulé — aucune écriture réelle

Cette couche orchestre le préflight Wave et la machine d’état des tentatives fournisseur **sans fournir d’implémentation réseau Wave**.

## Exécution

`executePreparedWaveIssuance` :

1. exige un plan `READY_FOR_WAVE_ADAPTER`;
2. passe la tentative locale de `PREPARED` à `IN_FLIGHT`;
3. appelle uniquement l’adaptateur injecté `issueAuthorizedInvoice`;
4. compare le résultat normalisé au client, total, taxes et devise attendus;
5. enregistre ensuite `CONFIRMED`, `FAILED_RETRYABLE`, `FAILED_FINAL` ou `AMBIGUOUS`.

Une exception, réponse malformée ou divergence de total/client après le démarrage devient `AMBIGUOUS`. Aucun retry automatique n’est effectué.

## Réconciliation

`reconcileAmbiguousWaveIssuance` appelle seulement l’adaptateur injecté `reconcileAuthorizedInvoice`.

- `FOUND` : doit correspondre exactement au client et aux montants attendus avant `CONFIRMED`;
- `NOT_FOUND` : autorise la machine d’état à passer à `RECONCILED_NOT_FOUND`;
- `UNKNOWN` ou erreur : aucune transition; la tentative reste ambiguë.

## Séparation de l’envoi

Le runner ne possède aucune opération d’envoi de facture. L’envoi client devra rester un workflow séparé avec une confirmation propriétaire distincte.

## Adaptateur réel futur

Le futur adaptateur Wave réel devra normaliser les réponses en objets stricts consommés par ce runner. Il ne sera activé qu’avec un compte Wave de test autorisé, des mappings persistants vérifiés et une stratégie de réconciliation testée.
