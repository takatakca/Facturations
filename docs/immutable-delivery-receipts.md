# Reçu local immuable de livraison confirmée

Cette brique matérialise un reçu local uniquement lorsqu’une tentative de livraison de la migration 018 est déjà `CONFIRMED`.

## Important : preuve simulée seulement

Le fournisseur actuel de la tentative est `SIMULATED_EMAIL`.

Le reçu porte donc :

- `status = DELIVERY_CONFIRMED_SIMULATED`;
- `proof_scope = SIMULATED_ADAPTER_ONLY`.

Il prouve que la machine d’état locale et son adapter simulé ont confirmé un résultat. Il **ne prouve pas qu’un courriel réel a été remis, accepté ou reçu**.

## Provenance figée

Le reçu conserve :

- ID de tentative;
- ID d’autorisation de livraison;
- ID de facture émise;
- ID du PDF qualifié;
- SHA-256 du PDF qualifié;
- destinataire attendu;
- SHA-256 du snapshot destinataire;
- fournisseur;
- message ID fournisseur simulé;
- clé d’opération;
- date de confirmation de la tentative;
- SHA-256 du reçu canonique.

Avant insertion, le store revérifie toute la chaîne :

1. tentative `CONFIRMED`;
2. fournisseur `SIMULATED_EMAIL`;
3. message ID et date de fin présents;
4. autorisation encore `AUTHORIZED_PENDING_DELIVERY`;
5. facture encore `ISSUED_CONFIRMED`;
6. SHA-256 du document identique;
7. destinataire identique au snapshot de facture.

## Immutabilité et idempotence

Une tentative ne peut produire qu’un seul reçu. Le reçu est append-only; UPDATE et DELETE sont bloqués par PostgreSQL.

Relancer la matérialisation de la même tentative retourne le même reçu. Une divergence de provenance provoque un conflit.

## Frontière

Cette étape :

- n’envoie aucun courriel;
- ne contacte aucun fournisseur;
- ne transforme pas le reçu simulé en preuve réelle;
- ne modifie aucun `delivery_state`;
- ne crée aucun paiement;
- ne modifie pas Wave;
- n’ajoute aucune route publique.

Avant un vrai fournisseur email, un nouveau type de preuve devra distinguer au minimum l’acceptation API fournisseur, les webhooks de livraison/échec et les événements ultérieurs.
