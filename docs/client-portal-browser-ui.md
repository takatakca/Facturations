# Interface navigateur du portail client

Cette couche branche le navigateur uniquement sur l’authentification passwordless et le read-model cloisonné déjà existants.

## Parcours

1. Le client ouvre un lien à usage unique vers `/portal/access?token=…`.
2. Le GET **ne consomme pas** le token. Il affiche une confirmation FR/EN.
3. Le POST same-origin consomme le token une seule fois et crée un cookie client séparé :
   - préfixe `__Host-`;
   - `Secure`;
   - `HttpOnly`;
   - `SameSite=Lax`;
   - durée 12 heures.
4. `/portal` liste seulement les factures explicitement publiées pour le client de la session.
5. `/portal/invoices/:id` affiche le détail financier.
6. `/portal/documents/:id.pdf` retourne uniquement le PDF qualifié publié et revalidé par le read-model.
7. `POST /portal/logout` révoque la session.

## Cloisonnement

Le navigateur ne fournit jamais de `customer_id`.

Le client ne peut pas obtenir une facture par numéro seul. Les UUID présents dans les URLs ne sont jamais considérés comme une autorisation : chaque lecture repasse par la session client, la publication OWNER active et le contrôle tenant/customer du read-model.

Les publications révoquées deviennent invisibles.

## Preuves financières

Les états de paiement sont affichés avec leur `proofScope`.

- `SYNTHETIC_ONLY` est présenté explicitement comme test synthétique;
- `NONE` comme absence de preuve externe;
- `VERIFIED_PROVIDER_PRESENT` seulement lorsque le ledger contient une preuve fournisseur vérifiée.

L’interface ne transforme jamais une preuve synthétique en paiement réel.

## Sécurité du magic link

Un scanner de courriel qui fait seulement un GET ne consomme pas le lien. La consommation exige une confirmation POST same-origin.

Le token n’est jamais stocké dans localStorage ou JavaScript client. Les réponses sont `no-store` et `Referrer-Policy: no-referrer`.

## Frontière

Cette brique rend le portail navigable, mais ne crée pas elle-même un email réel contenant le magic link.

Elle ne :

- choisit aucun fournisseur courriel réel;
- ne débite ni ne rembourse;
- n’écrit chez Wave;
- ne déploie rien;
- ne supprime aucune barrière OWNER.

L’activation réelle dépend toujours du staging HTTPS, du fournisseur email homologué et de la configuration production.
