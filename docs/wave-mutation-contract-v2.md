# Contrat de mutation Wave v2 — sans réseau

Ce lot fige uniquement la forme des mutations Wave nécessaires à l’émission future. Il ne contient aucun token, aucun client HTTP et aucun appel externe.

## Source vérifiée

Le 23 septembre 2026, la documentation Wave publique indique :

- `invoiceCreate(input: InvoiceCreateInput!)` pour créer une facture;
- `InvoiceCreateStatus` accepte `DRAFT` ou `SAVED`;
- `InvoiceCreateItemInput.taxes` référence les taxes par `salesTaxId`;
- le champ `InvoiceCreateItemTaxInput.amount` est déprécié et ne doit pas être utilisé;
- `invoiceApprove(input: InvoiceApproveInput!)` approuve une facture identifiée par `invoiceId`;
- `invoiceSend` est une mutation distincte et exige que `Business.emailSendEnabled` soit activé.

## Décision Facturations

Le contrat v2 construit volontairement deux opérations séparées :

1. `invoiceCreate` avec `status: DRAFT`;
2. `invoiceApprove` seulement après confirmation de la création.

Aucun `invoiceNumber` n’est fourni par Facturations. Wave demeure responsable de sa numérotation selon ses règles courantes.

L’envoi courriel n’est pas inclus dans ce module. Il restera une confirmation propriétaire distincte dans un lot futur.

## Entrée create

Le constructeur consomme uniquement le plan persistant `READY_FOR_WAVE_ADAPTER` produit par le mapping figé de la PR #76.

Il refuse :

- des actions externes déjà marquées exécutées;
- des champs supplémentaires comme token ou payload libre;
- des lignes non taxables ayant des taxes;
- des IDs de taxes dupliqués;
- des dates invalides;
- une date d’échéance antérieure à la date de facture.

Les montants internes en cents sont convertis en chaînes décimales à deux chiffres. Les quantités internes sont des entiers et deviennent des chaînes décimales Wave.

## Taxes et rabais

Les taxes utilisent seulement `{ salesTaxId }`. Le montant de taxe déprécié n’est jamais envoyé.

Les rabais ne sont pas ajoutés ici. Les rabais par ligne sont déjà refusés dans le préflight tant qu’une équivalence Wave exacte n’est pas démontrée.

## Classification pure des réponses

Les fonctions de classification n’effectuent aucun réseau.

- une création réussie doit revenir comme facture `DRAFT` et correspondre exactement au client, à la devise, au total et aux taxes attendus;
- cette création est classée `CREATE_CONFIRMED_DRAFT_ONLY`, jamais comme facture officiellement approuvée;
- une approbation réussie doit concerner le même ID, revenir `SAVED`, conserver le client, la devise, le total et les taxes, et fournir un numéro de facture;
- une réponse divergente ou incomplète devient `AMBIGUOUS`;
- des erreurs de validation Wave explicites deviennent `FAILED_FINAL`.

## Limites

Ce module ne sait pas envoyer une requête HTTP, ne possède aucun secret et ne peut pas émettre une facture par lui-même.

Avant tout adaptateur réel : compte Wave de test explicitement autorisé, lecture réelle vérifiée, mutation contrôlée, persistance de la tentative avant réseau et réconciliation des résultats ambigus.
