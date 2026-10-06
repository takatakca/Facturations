# Paiements Stripe vérifiés (`VERIFIED_PROVIDER_WEBHOOK`)

Cette étape permet au ledger de paiement d’enregistrer une **vraie** preuve de paiement, mais uniquement à partir d’un webhook Stripe dont Facturations a lui-même vérifié la signature.

## Route

`POST /webhooks/stripe/payments`

- active seulement si `FACTURATIONS_STRIPE_WEBHOOK_SECRET` (format `whsec_…`), `FACTURATIONS_DATABASE_URL` et `WAVE_BUSINESS_ID` sont configurés;
- montée avant les gardes cookie/navigateur : Stripe n’a ni cookie ni origine, la signature est la seule autorisation;
- corps brut limité à 1 Mo, aucune query acceptée (422), uniquement `POST` (405);
- réponses minimales : `{ received, recorded }` ou `{ error: CODE }`; aucune donnée Stripe n’est renvoyée.

## Vérification

Implémentée sans SDK dans `src/stripe-payment-webhook.js` :

1. en-tête `Stripe-Signature` parsé strictement (`t=` + un ou plusieurs `v1=` hex de 64 caractères);
2. tolérance d’horloge de 300 s dans les deux sens;
3. HMAC-SHA256 de `"<t>.<body brut>"` avec le secret d’endpoint, comparé en temps constant;
4. le JSON n’est parsé **qu’après** une signature valide.

## Événements retenus

Seuls `checkout.session.completed` et `checkout.session.async_payment_succeeded` d’une Checkout Session :

- `metadata.facturations_business_id` = `WAVE_BUSINESS_ID` de cette instance (sinon ignoré, 200);
- `metadata.facturations_issued_invoice_id` = UUID d’une facture émise de ce business;
- `mode=payment`, `payment_status=paid` (sinon ignoré, 200);
- `currency=cad`, `amount_total` entier > 0, `payment_intent` `pi_…` (sinon 422).

L’événement devient `PAYMENT_RECEIVED` avec `provider_key=STRIPE`, `provider_event_id=evt_…` et `provider_transaction_id=pi_…`.

## Provenance persistée

La migration 046 ajoute `webhook_body_sha256` et `verification_scheme` à `facturations_payment_evidence` et remplace la contrainte de mode par :

- `SYNTHETIC_TEST` ⇒ provenance NULL;
- `VERIFIED_PROVIDER_WEBHOOK` ⇒ `provider_key=STRIPE`, SHA-256 du body brut et `verification_scheme=STRIPE_SIGNATURE_V1` obligatoires.

Le store expose `ingestVerifiedStripe()` (provider `STRIPE` uniquement). Il n’existe toujours aucune méthode pour déclarer une preuve réelle sans passer par la vérification.

## Idempotence et erreurs

- même `evt_…` rejoué par Stripe ⇒ 200, aucune double écriture;
- autre événement réutilisant le même `pi_…` ⇒ 409;
- facture inconnue ⇒ 404 (Stripe réessaie et l’opérateur voit l’échec dans le dashboard Stripe);
- erreur de stockage ⇒ 503 sans détail (Stripe réessaie).

La projection financière passe alors à `proofScope=VERIFIED_PROVIDER_PRESENT`, la seule valeur que TAKATAK affiche comme « Payée ».

## Mise en service

1. Dans Stripe : Developers → Webhooks → endpoint `https://<facturations>/webhooks/stripe/payments`, événements `checkout.session.completed` et `checkout.session.async_payment_succeeded`.
2. Copier le signing secret (`whsec_…`) dans la variable privée `FACTURATIONS_STRIPE_WEBHOOK_SECRET` de l’application Facturations dans Coolify. Ne jamais le coller dans un chat, un dépôt ou un navigateur.
3. Utiliser d’abord le mode test Stripe sur le staging.

## Tests

`tests/stripe-payment-webhook.test.js` couvre la signature (secret erroné, body altéré, horodatage hors tolérance, en-têtes malformés, plusieurs `v1`), le mapping, la route HTTP et, avec PostgreSQL jetable, le parcours complet jusqu’à `PAID`/`VERIFIED_PROVIDER_PRESENT`, le rejeu, la réutilisation de PaymentIntent et les contraintes de provenance. Toutes les données sont synthétiques.
