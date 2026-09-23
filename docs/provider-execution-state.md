# État d’exécution fournisseur — garde anti-duplication

Ce module prépare la future écriture Wave **sans effectuer aucun appel réseau**.

## But

Une autorisation d’émission enregistrée dans `facturations_issuance_authorizations` peut produire au maximum une tentative logique dans `facturations_provider_executions`. Cette tentative reçoit une clé d’opération locale aléatoire de 32 octets encodée base64url et cette clé ne change pas lors d’un retry.

Le store est backend-only : aucune route navigateur ne peut directement changer l’état fournisseur.

## États

- `PREPARED` : tentative persistée, aucun appel externe commencé.
- `IN_PROGRESS` : le futur adaptateur a commencé une tentative.
- `AMBIGUOUS` : résultat inconnu, par exemple un timeout après envoi possible.
- `FAILED_RETRYABLE` : échec dont l’absence d’émission a été établie et qui peut être retenté.
- `FAILED_FINAL` : échec terminal.
- `CONFIRMED` : le futur adaptateur a obtenu et vérifié un identifiant fournisseur et un numéro officiel.

## Règle critique

Un état `AMBIGUOUS` **ne peut jamais être retenté directement**.

Il doit d’abord passer par une réconciliation :

- trouvé chez le fournisseur → `CONFIRMED`;
- absence établie → `FAILED_RETRYABLE`;
- échec terminal établi → `FAILED_FINAL`.

Le retry après `FAILED_RETRYABLE` réutilise la même clé d’opération locale.

## Ce lot ne fait pas

Il n’appelle pas Wave, ne crée aucune facture externe, ne modifie pas `invoice_drafts.status`, ne génère aucun PDF officiel, n’envoie aucun courriel et ne traite aucun paiement.

Les tests peuvent enregistrer des identifiants fournisseur **synthétiques** pour exercer les transitions. Cela ne constitue pas une émission réelle.

Migration : `db/012_provider_execution_state.sql`.
Store : `src/provider-execution-store.js`.
