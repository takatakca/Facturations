# GO / NO-GO — homologation du staging Facturations

Le verdict de mise en service ne doit jamais reposer sur une impression générale ou sur une CI verte seule.

`scripts/evaluate-staging-readiness.js` évalue un dossier JSON privé contenant les preuves du **SHA exact** candidat à la mise en service.

## Utilisation

Copier `ops/staging-readiness.example.json` vers un emplacement privé hors dépôt, puis compléter les preuves sans y placer de secret.

Exemple :

```bash
FACTURATIONS_RELEASE_SHA=<sha-exact-40-hex> \
node scripts/evaluate-staging-readiness.js /chemin/prive/staging-readiness.json
```

Codes de sortie :

- `0` : **GO** — tous les gates obligatoires sont PASS avec le bon type de preuve;
- `2` : **NO-GO** — au moins un gate obligatoire est BLOCKED;
- `1` : dossier invalide, stale, mauvais SHA, gate manquant ou preuve de mauvaise portée.

Le dossier doit avoir été réévalué dans les 24 heures et correspondre au SHA exact fourni par `FACTURATIONS_RELEASE_SHA`.

## Séparation des preuves

Le moteur distingue volontairement plusieurs portées :

- `CI_SYNTHETIC` — tests automatisés jetables;
- `REAL_GITHUB` — règle réellement active dans GitHub;
- `HUMAN_REVIEW` — revue humaine indépendante;
- `REAL_STAGING` — preuve obtenue sur l’hébergement staging réel;
- `REAL_PROVIDER` — preuve obtenue avec le fournisseur externe de staging;
- `REGULATORY_REVIEW` — validation comptable/fiscale/confidentialité;
- `SECURITY_REVIEW` — revue sécurité dédiée;
- `HOSTING_SIGNOFF` — validation opérationnelle de l’hébergeur.

Une preuve `CI_SYNTHETIC` ne peut pas satisfaire un gate `REAL_STAGING`, `REAL_PROVIDER`, humain ou réglementaire.

## Gates obligatoires

### Développement et régression

- core CI Node 20/22 + PostgreSQL;
- navigateur FR/EN;
- MFA + PostgreSQL;
- backup/restore CI;
- runtime DB least-privilege;
- tests de redaction des logs.

### Gouvernance GitHub

- protection réelle de `main`;
- revue humaine indépendante du SHA candidat.

### Staging réel

- HTTPS/proxy/Host;
- port Node non exposé directement;
- base réellement dédiée;
- rôle runtime réellement least-privilege;
- backup/restauration staging réel;
- logs staging sans PII/secrets;
- drill de récupération MFA;
- accessibilité/mobile sur staging.

### Légal, fiscal, confidentialité

- identité légale de l’émetteur;
- revue taxes/comptabilité;
- politique confidentialité/rétention.

### Fournisseurs

- Wave sur compte de staging autorisé;
- fournisseur email staging;
- signature webhook officielle;
- processeur paiement staging.

### Sécurité et opérations

- validation du flux IA/voix : ambiguïté, prompt injection, double action et confirmations;
- revue de vulnérabilités;
- sign-off de l’hébergement.

## Références de preuve

Le champ `reference` doit être un identifiant court et non secret : numéro de run, ticket, rapport ou preuve interne. Le CLI n’imprime jamais les références dans son résumé afin de réduire les risques de fuite.

Ne jamais mettre dans le dossier :

- mots de passe;
- tokens;
- cookies;
- chaînes de connexion;
- données client;
- contenu de facture;
- clés API;
- codes MFA.

## Interprétation

**GO** signifie uniquement que le dossier d’homologation du SHA exact satisfait tous les contrôles définis ici.

Il ne remplace pas :
- une décision opérationnelle du propriétaire;
- une revue juridique;
- une surveillance post-déploiement;
- un plan de rollback.

Après tout nouveau commit sur le candidat, le SHA change et le dossier précédent doit être rejeté.
