# Reçu local immuable de livraison confirmée

Après une tentative de livraison `CONFIRMED`, Facturations peut matérialiser un reçu local append-only.

Le reçu fige :

- l’ID de tentative;
- l’autorisation OWNER;
- la facture émise;
- l’ID et le SHA-256 du PDF qualifié;
- le destinataire exact;
- le hash du snapshot destinataire;
- le fournisseur;
- l’identifiant de message retourné par l’adapter;
- l’horodatage de confirmation;
- un SHA-256 du reçu lui-même.

La matérialisation revérifie toute la chaîne de provenance avant insertion et est idempotente. UPDATE et DELETE sont interdits par trigger PostgreSQL.

## Limite essentielle

Le fournisseur reste `SIMULATED_EMAIL`. Un reçu matérialisé prouve que **notre machine locale** a enregistré un résultat `CONFIRMED` de l’adapter simulé. Il ne constitue pas une preuve indépendante qu’un courriel a atteint une boîte externe.

Cette étape ne :

- contacte aucun fournisseur réel;
- n’envoie aucun courriel;
- ne modifie aucun `delivery_state`;
- ne modifie aucune facture ou PDF;
- ne crée aucun paiement;
- n’effectue aucun appel Wave;
- n’ajoute aucune route publique.

Un fournisseur réel devra être homologué séparément en staging avant que la sémantique de preuve externe puisse être renforcée.
