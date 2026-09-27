# Durcissement de préproduction : edge HTTPS et readiness

Cette couche ajoute des garanties applicatives avant toute homologation réelle de `facturations.bolon.ca`.

## Démarrage production fail-closed

Avec `NODE_ENV=production`, l'application refuse de démarrer si l'un des éléments suivants manque :

- base PostgreSQL Facturations dédiée;
- `WAVE_BUSINESS_ID` tenant-scoped;
- origine HTTPS exacte `FACTURATIONS_PUBLIC_ORIGIN`;
- clé MFA/TOTP de 32 octets;
- `FACTURATIONS_TRUST_PROXY=1`;
- port explicite non nul.

Cette validation ne remplace pas les contrôles de l'hébergeur.

## Reverse proxy HTTPS

Quand une origine HTTPS est configurée, le serveur applique globalement :

- `Strict-Transport-Security: max-age=31536000`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`.

En mode production, le garde de bord exige en plus :

- le `Host` exact de `FACTURATIONS_PUBLIC_ORIGIN`;
- `X-Forwarded-Proto: https`.

Toute divergence est refusée avec HTTP 421 avant que les handlers applicatifs ne s'exécutent.

### Limite réseau importante

Un header proxy est forgeable si le port Node est accessible directement. L'hébergeur doit donc imposer une barrière réseau réelle :

- port Node inaccessible depuis Internet;
- trafic vers Node provenant uniquement du reverse proxy de confiance;
- TLS terminé sur ce proxy;
- aucune exposition parallèle HTTP directe.

## Liveness vs readiness

`GET /health` vérifie uniquement que le processus répond.

`GET /ready` vérifie en plus la dépendance PostgreSQL via un `SELECT true`.

- DB disponible => HTTP 200, `readiness=ready`;
- DB absente/non configurée/indisponible => HTTP 503;
- aucune chaîne de connexion, erreur SQL ou secret n'est exposé dans la réponse.

Les load balancers et contrôles de préproduction doivent utiliser `/ready` pour décider si l'application peut recevoir du trafic.

## Preflight staging

`scripts/staging-readonly-preflight.js` exige maintenant cinq contrôles anonymes HTTPS :

1. `/health`;
2. `/ready`;
3. login MFA FR;
4. route privée historique refusée anonymement;
5. route CSRF refusée anonymement.

Chaque réponse doit avoir un certificat valide, HSTS, `nosniff`, `no-referrer`, aucune redirection imprévue et aucune CORS permissive.

Ce script est strictement en lecture seule. Il n'autorise ni émission, ni courriel, ni paiement, ni mutation Wave.

## Ce que cette couche ne prouve pas

Elle ne prouve pas à elle seule :

- que le firewall/proxy bloque réellement le port Node;
- que les backups sont restaurables;
- que le certificat public final est correctement renouvelé;
- qu'un fournisseur email, paiement ou Wave réel est homologué;
- que la configuration MochaHost est correcte.

Ces preuves doivent être collectées sur le staging réel avant production.
