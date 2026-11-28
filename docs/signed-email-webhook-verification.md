# Contrat de vérification webhook signé

Cette barrière interne sépare un corps HTTP reçu d’une preuve pouvant être persistée comme provenant d’un webhook signé.

Aucun fournisseur commercial réel n’est encore homologué dans cette release.

## Principe

Un futur intégrateur fournisseur doit injecter une fonction `verifyAndParse()` spécifique au fournisseur dans `createEmailWebhookVerifier()`, avec un `providerKey` et un `verificationScheme` configurés.

La fonction reçoit :

- le provider key configuré;
- les headers normalisés;
- les octets bruts du body.

Elle doit vérifier la signature selon la documentation officielle du fournisseur **avant** de retourner un événement canonique.

## Enveloppe vérifiée

`createEmailWebhookVerifier(...).verify()` ne retourne une enveloppe interne qu’après :

1. validation des headers et du body;
2. rejet des noms de headers ambigus ou dupliqués après normalisation;
3. succès de `verifyAndParse()`;
4. normalisation de l’événement avec le contrat fournisseur;
5. correspondance exacte du provider key;
6. scellement du `verificationScheme` configuré dans l’enveloppe interne.

L’enveloppe contient aussi le SHA-256 du body brut.

Le module maintient une marque interne en mémoire (`WeakSet`). Copier les propriétés de l’enveloppe ne crée pas une nouvelle enveloppe vérifiée.

## Liaison à une livraison réelle du système

Une enveloppe signée acceptée ne peut pas être rattachée arbitrairement à une facture.

Avant persistance en `SIGNED_WEBHOOK`, le store exige une tentative de livraison `CONFIRMED` correspondant exactement au même :

- tenant;
- PDF qualifié;
- `operationKey`;
- `providerMessageId`.

La provenance PostgreSQL renforce ensuite cette liaison.

## Fail closed

Une exception du vérificateur devient :

`WEBHOOK_SIGNATURE_VERIFICATION_FAILED / 401`

Un événement malformé devient :

`VERIFIED_WEBHOOK_EVENT_INVALID`

Un provider key divergent devient un conflit.

Le store d’évidence ne reçoit pas le mécanisme de vérification comme paramètre séparé : il persiste uniquement la valeur scellée dans l’enveloppe effectivement vérifiée.

## Portée de preuve actuelle

`signatureVerified=true` et `signedWebhookVerified=true` signifient que l’enveloppe a franchi le vérificateur injecté et les contrôles de provenance internes.

`realWebhookVerified` reste `false` dans cette release tant qu’un fournisseur commercial réel et son algorithme de signature n’ont pas été homologués.

Cette release :

- n’expose aucune route webhook publique de production;
- ne contient aucune clé secrète fournisseur réelle;
- n’effectue aucun envoi de courriel réel;
- ne revendique aucune preuve fournisseur commerciale réelle.
