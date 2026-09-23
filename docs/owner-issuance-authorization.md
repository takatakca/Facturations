# Autorisation d’émission — étape interne avant fournisseur

Cette étape ajoute une décision **distincte** après l’approbation interne du brouillon.

## Ce qu’elle fait

Un OWNER authentifié peut ouvrir `/internal/review/:uuid/authorize-issuance?lang=fr|en` uniquement après l’approbation interne du brouillon. La page affiche de nouveau le destinataire et le total calculé, puis exige une confirmation explicite. Une décision acceptée crée une ligne immuable dans `facturations_issuance_authorizations` avec l’état :

`AUTHORIZED_PENDING_PROVIDER`

L’enregistrement est lié à l’entreprise, au brouillon, au propriétaire, au `request_hash`, au total attendu, au courriel attendu et au fournisseur prévu `WAVE`. Un retry strictement identique du même propriétaire est idempotent. Une session révoquée, un rôle STAFF, un brouillon non approuvé, un changement de total/destinataire ou une autorisation concurrente incompatible sont refusés.

## Ce qu’elle ne fait pas

Cette autorisation **n’est pas une émission**.

Elle ne :

- crée aucun numéro de facture officiel;
- ne modifie pas `invoice_drafts.status`, qui reste `DRAFT`;
- n’appelle aucune API Wave;
- ne crée ni n’archive de PDF officiel;
- n’envoie aucun courriel;
- ne prend ni ne rapproche aucun paiement.

Les résultats du store exposent explicitement `issued:false`, `waveSynced:false` et `emailed:false`.

## Pourquoi cette étape existe

L’émission future vers Wave est une action externe et potentiellement irréversible. L’autorisation propriétaire est donc conservée séparément de l’approbation interne du contenu. Le futur connecteur fournisseur devra encore :

1. vérifier que cette autorisation existe et correspond exactement au snapshot;
2. utiliser une clé d’idempotence externe persistée;
3. traiter les timeouts ambigus par réconciliation avant tout retry;
4. enregistrer l’identifiant fournisseur et le numéro officiel seulement après réponse vérifiée;
5. ne jamais interpréter cette autorisation comme permission d’envoyer un courriel.

Migration dédiée : `db/011_issuance_authorizations.sql`. Elle ne doit être appliquée que sur la base PostgreSQL dédiée à Facturations.
