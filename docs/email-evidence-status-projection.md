# Synthèse lecture seule des preuves courriel

Cette brique ajoute une projection PostgreSQL au-dessus du ledger append-only de la migration 020.

Elle ne modifie, ne remplace et ne supprime aucun événement.

## Pourquoi ne pas produire un simple statut final

Les événements fournisseur peuvent refléter des réalités différentes. Par exemple, un message peut avoir un événement `DELIVERED`, puis un événement `COMPLAINT`. Une synthèse qui écraserait l’historique par un seul statut ferait perdre une information importante.

La projection expose donc :

- le dernier type d’événement observé;
- le nombre d’événements;
- premier/dernier timestamp;
- `hasDelivered`;
- `hasBounced`;
- `hasComplaint`;
- dernier timestamp de chaque type;
- présence éventuelle d’une preuve `SIGNED_WEBHOOK`;
- portée de preuve.

## Portée de preuve

Tant que tous les événements sont synthétiques :

`proofScope = SYNTHETIC_ONLY`

Si un futur code homologué ingère au moins un événement signé :

`proofScope = SIGNED_WEBHOOK_PRESENT`

La présence de ce marqueur ne certifiera pas à elle seule le contenu : la future couche webhook devra vérifier cryptographiquement la signature avant insertion.

## Frontière

Cette étape est en lecture seule.

Elle :

- n’envoie aucun courriel;
- ne crée aucun event;
- ne transforme aucun événement synthétique en événement réel;
- ne change aucun `delivery_state`;
- n’ajoute aucun endpoint public.

La prochaine décision structurante est le choix du fournisseur de staging et son mécanisme officiel de signature webhook.
