# Contrat de vérification webhook signé

Cette étape crée une barrière interne entre un corps HTTP reçu et une preuve autorisée à être considérée comme issue d’un webhook signé.

Aucun fournisseur commercial n’est encore choisi.

## Principe

Un futur intégrateur fournisseur devra injecter une fonction `verifyAndParse()` spécifique au fournisseur.

Cette fonction recevra :

- le provider key configuré;
- les headers normalisés;
- les octets bruts du body.

Elle devra vérifier la signature selon la documentation officielle du fournisseur **avant** de retourner un événement canonique.

## Enveloppe vérifiée

`createEmailWebhookVerifier(...).verify()` ne retourne une enveloppe interne qu’après :

1. validation des headers et du body;
2. succès de `verifyAndParse()`;
3. normalisation de l’événement avec le contrat fournisseur;
4. correspondance exacte du provider key.

L’enveloppe contient aussi le SHA-256 du body brut.

Le module maintient une marque interne en mémoire (`WeakSet`). Copier les propriétés de l’enveloppe ne crée pas une nouvelle enveloppe vérifiée.

## Fail closed

Une exception du vérificateur devient :

`WEBHOOK_SIGNATURE_VERIFICATION_FAILED / 401`

Un événement malformé devient :

`VERIFIED_WEBHOOK_EVENT_INVALID`

Un provider key divergent devient un conflit.

## Frontière actuelle

Cette PR :

- n’expose aucune route HTTP;
- n’écrit aucun `SIGNED_WEBHOOK` en base;
- ne contient aucune clé secrète;
- n’implémente aucun algorithme fournisseur réel;
- n’utilise aucun SDK fournisseur;
- n’envoie aucun courriel.

Le lot suivant pourra permettre au ledger d’accepter uniquement ces enveloppes vérifiées, tout en persistant le hash du body et la provenance de vérification.
