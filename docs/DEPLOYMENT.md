# Facturations — Déploiement vérifiable, sans production implicite

**Statut au 2026-10-16 : aucun environnement déployé/accessible n'a été vérifié dans cette session.** Ne pas présenter l'existence d'un workflow CI, d'une URL cible ou d'un Dockerfile en PR comme un déploiement réussi.

## Hébergement cible et ambiguïté à résoudre

- Le [README](../README.md) et [AGENTS](../AGENTS.md) mentionnent `facturations.bolon.ca`, MochaHost, un hôte et une base exclusivement dédiés.
- [PR #159](https://github.com/takatakca/Facturations/pull/159) propose un **staging** isolé sous Coolify sur Contabo, avec Dockerfile et procédures de migrations/bootstrap; cette PR n'est pas fusionnée.
- Ces cibles ne doivent pas être confondues. La plateforme définitive, le DNS, le proxy HTTPS et les ressources allouées doivent être constatés avant tout déploiement.

## Pipeline existant

`.github/workflows/ci.yml` teste Node 20 et 22 avec PostgreSQL 16 jetable, `npm ci`, audit npm, intégrité des migrations, `npm run check`, `npm test` et un exercice isolé de restauration. D'autres workflows couvrent Chromium et les privilèges runtime.

Le futur job de vérification de relève ajoute `npm run check:project-docs`. **Aucun workflow de production autorisé n'est confirmé.** Ne pas ajouter une étape d'émission, d'email ou une migration réelle à un simple `push` sans isolation et gates.

**Protection des événements de paiement :** `FACTURATIONS_STRIPE_ALLOW_TEST_MODE=1` est réservé au développement/staging isolé. [PR #169](https://github.com/takatakca/Facturations/pull/169) fait échouer le démarrage en `NODE_ENV=production` si le drapeau est activé; n'activer aucun traitement Stripe réel sans contrat et vérification du fournisseur.

## Déploiement staging seulement après préparation autorisée

1. Revoir et fusionner le kit de déploiement #159 ou un équivalent vérifié.
2. Vérifier infrastructure réellement isolée : nouvelle base PostgreSQL dédiée à Facturations, cert TLS public, proxy et port Node privé. Ne jamais réutiliser les bases TAKATAK existantes.
3. Stocker les secrets hors GitHub public et hors journaux. Confirmer `NODE_ENV=production`, `FACTURATIONS_DATABASE_URL`, `WAVE_BUSINESS_ID`, `FACTURATIONS_PUBLIC_ORIGIN`, `FACTURATIONS_TOTP_ENCRYPTION_KEY` et `FACTURATIONS_TRUST_PROXY=1`, uniquement sur la machine autorisée.
4. Contrôler le lock de migrations avec `npm run check:migrations`; appliquer les migrations uniquement avec un compte opérateur autorisé sur la base dédiée et sauvegardée. Voir les commandes de #159 seulement après revue.
5. Vérifier le rôle runtime avec `npm run check:runtime-db`, les réponses `/health` et `/ready` en HTTPS, le preflight `scripts/staging-readonly-preflight.js` et la connectivité sans port Node public.
6. Effectuer MFA et droits OWNER/STAFF/client, restauration de sauvegarde, redaction des logs, tests mobile/accessibilité et tests interentreprises.
7. Remplir le dossier privé `npm run go-no-go:staging` pour le SHA exact. **Interdire les fournisseurs externes réels tant que leurs gates sont NO-GO.**

**Contrôle de drainage :** [PR #170](https://github.com/takatakca/Facturations/pull/170) vérifie que `/ready` cesse de signaler READY dès le début du drainage, même lorsqu'une requête PostgreSQL déclenchée auparavant termine positivement ensuite. Cette garantie est testée en CI avec une promesse différée, **pas encore validée en staging réel**. Exercer le scénario en HTTPS isolé avant la publication.

**Nettoyage en cas d'échec HTTP :** [PR #171](https://github.com/takatakca/Facturations/pull/171) garantit une tentative de libération du pool PostgreSQL même si `server.close` échoue (erreur callback ou exception), et conserve `exitCode=1` si une étape échoue. CI sur données synthétiques uniquement; répéter le test en staging isolé avant toute homologation. Ne pas déployer en production sur la seule preuve CI.

## Publication et rollback

Figer SHA Git, checks et configuration; vérifier le SHA réellement actif sur l'hébergeur par méthode attestée, sans exposer de secret ni token. Vérifier santé HTTPS, monitoring et rollback; ne déclarer `DEPLOYED` qu'après preuves réelles. Références détaillées : [runbook](final-go-live-runbook.md), [gates](staging-go-no-go.md), [lecture seule staging](staging-readonly-preflight.md).

Si le certificat, le démarrage, la sécurité d'accès, les états d'une tentative Wave ou l'intégrité SQL échouent : arrêter les nouvelles écritures, rendre `/ready` indisponible, restaurer le **code** à la version homologuée compatible avec la base, puis réconcilier tout appel fournisseur ambigu; ne jamais rejouer aveuglément une facture.
