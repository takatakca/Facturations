# GROUPE TAKATAK — Facturations

**En développement — aucune facture réelle ne doit être émise.** Application Node.js indépendante destinée à un environnement et une base PostgreSQL **exclusifs à Facturations**, distincts des services TAKATAK existants. Le dépôt est **public** : ne jamais committer de `.env`, jetons, mots de passe, données clients réelles, factures, sauvegardes ou journaux sensibles. Ni `facturations.bolon.ca` ni une connexion Wave réelle n'ont été homologués. L'[audit de préparation #27](https://github.com/takatakca/Facturations/issues/27) et la [PR de revue globale #63](https://github.com/takatakca/Facturations/pull/63) distinguent code proposé, tests et blocages. **Les fonctionnalités ci-dessous sont proposées sur la branche de la PR #63, non fusionnées dans `main`.**

## Parcours interne présent dans la PR #63

- Connexion du personnel FR/EN par mot de passe et TOTP activé, session révocable dans PostgreSQL et cookie `Secure`, `HttpOnly`, `SameSite=Strict`. Invitations et enrôlement initial exigent encore une procédure d'exploitation de confiance; aucune livraison d'invitation ni récupération MFA réelle n'est prête.
- Tableau de bord privé, éditeur mobile FR/EN, recherche et historique des espaces de travail propres à chaque employé/entreprise. Sauvegarde manuelle et **automatique après trois secondes sans saisie**, côté serveur et avec révisions. Aucune sauvegarde automatique garantie en cas de fermeture avant le délai, de panne, de conflit entre onglets ou de réseau absent. Une erreur de session/conflit/stockage interrompt les nouveaux essais automatiques.
- Aperçu calculé **CAD seulement** avec montants en cents et taxes **explicitement fournies**; aucune détermination automatique de l'applicabilité fiscale. Le propriétaire peut vérifier une révision enregistrée, confirmer une **conversion distincte** en copie immuable `invoice_drafts` (migration 009), puis confirmer séparément une **approbation interne**. La conversion fige l'espace source, rejette ses nouvelles sauvegardes avec HTTP 409 et redirige ses anciennes pages vers la révision immuable pour le propriétaire autorisé. Cette approbation **n'est pas une émission**.
- Annuaire de clients et brouillons immuables isolés par entreprise, création idempotente, journal `DRAFT_CREATED`, vérifications serveur du destinataire et du total, recherche privée. Le connecteur Wave existant se limite à une **requête GraphQL en lecture seule** de la liste des entreprises, lorsqu'un jeton autorisé est configuré.

Les routes navigateur privées utilisent une session vérifiée en base, des contrôles de rôle/propriété et d'entreprise. Les écritures de brouillons exigent une protection CSRF et l'origine/Host attendus. Le cookie navigateur **n'autorise aucune écriture `/api/*`** ni action Wave. Le processus Node est HTTP derrière un futur proxy HTTPS de confiance; la configuration d'une origine HTTPS ne constitue pas une preuve de TLS réel.

**Non livré / non vérifié :** facture officielle numérotée et émission, synchronisation Wave en écriture, PDF de facture immuable, courriel client, paiement/rapprochement, portail client, assistant IA/vocal connecté, transfert STAFF → OWNER, récupération MFA, restauration de sauvegarde, validation fiscale/comptable et homologation HTTPS publique. Les suites Chrome existantes ne couvrent **pas encore dans une seule navigation** MFA → autosave → conversion → approbation. Les PR sont en brouillon : pas de fusion ni de déploiement.

## Installation de développement et tests jetables

Node.js >= 20.11 et npm; PostgreSQL 16 **local jetable** pour les tests d'intégration, jamais une base TAKATAK existante. Depuis une extraction propre :

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
cp .env.example .env
```

Le fichier **`package-lock.json` est présent**; `npm ci` respecte ses versions. Les tests PostgreSQL requièrent `FACTURATIONS_TEST_DATABASE_URL` pointant **uniquement** vers `127.0.0.1` ou `localhost` et `/facturations_test`. Initialiser cette base jetable avec `node scripts/setup-test-db.js` uniquement après avoir vérifié la cible. Ne définir **jamais** `FACTURATIONS_DATABASE_URL` pour le processus de tests. La CI exécute `npm ci`, l'audit des dépendances de production, `npm run check` et `npm test` sous Node 20/22 avec PostgreSQL 16; des parcours Chrome séparés utilisent des identités fictives `example.test`.

Pour le mode local non connecté : garder `.env` privé, `npm run dev`, puis examiner `http://127.0.0.1:3000/health`. Sans `TAKATAK_ADMIN_KEY`, les routes administratives privées restent indisponibles. Ne jamais inclure de clé administrative, identifiant de base ou jeton Wave dans le navigateur.

## Routes internes principales dans la branche de revue

| Méthode | Route | Limite |
| --- | --- | --- |
| GET | `/health` | Processus vivant seulement, pas une preuve de mise en service |
| GET / POST | `/internal/login?lang=fr\|en`, `/internal/login` | Formulaire FR/EN et MFA, si configuration privée complète |
| POST | `/internal/logout` | Révocation de session |
| GET | `/internal/dashboard?lang=fr\|en` | Tableau de bord privé |
| GET | `/internal/editor?lang=fr\|en` | Éditeur; option `id` pour reprendre un espace |
| GET | `/internal/recent-workspaces?lang=fr\|en` | Historique et recherche privés |
| GET | `/internal/workspaces/csrf` | Jeton CSRF lié à la session |
| POST / GET / PUT | `/internal/workspaces`, `/internal/workspaces/:uuid` | Création, chargement et sauvegarde conditionnée par révision/CSRF |
| GET | `/internal/workspaces/:uuid/preview?lang=fr\|en` | Aperçu calculé, **non émis** |
| GET / POST | `/internal/submit/:uuid?lang=fr\|en` | Confirmation OWNER et conversion en copie immuable, **non approuvée automatiquement** |
| GET / POST | `/internal/review/:uuid?lang=fr\|en` | Révision OWNER et approbation **interne seulement** |
| GET | `/internal/review?lang=fr\|en` | Liste privée de brouillons immuables |
| GET | `/api/wave/businesses` | Administrateur serveur uniquement; liste Wave en lecture seule |

`/api/drafts`, `/api/customers`, `/api/approvals` et les autres routes `/api/*` restent séparées des cookies navigateur : consulter `src/server.js` et les règles de rôle avant tout usage. Un identifiant UUID dans l'URL n'est **jamais** une autorisation. Le retour sur une ancienne page d'un espace déjà soumis redirige uniquement un OWNER qui est toujours propriétaire et authentifié; un ancien onglet non rechargé reçoit 409 à la sauvegarde.

Exemple fictif de contenu CAD (aucune taxe automatique) :

```json
{
  "currency": "CAD",
  "customer": { "name": "Example Customer", "email": "customer@example.test" },
  "invoiceDate": "2026-09-20",
  "dueDate": "2026-10-20",
  "lines": [{ "description": "Example service", "quantity": 2, "unitPriceCents": 1500, "discountCents": 0, "taxable": false }],
  "taxes": []
}
```

## Préalables à toute préproduction — PAS une procédure de déploiement

1. Confirmer auprès de l'exploitant une application et une base **Facturations seules**, DNS et vrai certificat HTTPS, proxy de confiance et port Node inaccessible directement, protection IP, rôle SQL minimal et journaux expurgés. Ne toucher à aucun service TAKATAK en exploitation.
2. Faire revoir et appliquer dans l'ordre les migrations dédiées `db/001` à **`db/009`**, **uniquement sur la base dédiée**; 008 fournit les espaces révisables et 009 leur lien immuable vers les brouillons soumis. Vérifier les droits SQL, les sauvegardes chiffrées et **une restauration effective** avant données réelles.
3. Configurer secrètement `FACTURATIONS_DATABASE_URL` et `WAVE_BUSINESS_ID` ensemble; activer `FACTURATIONS_PUBLIC_ORIGIN` et la clé hexadécimale aléatoire privée `FACTURATIONS_TOTP_ENCRYPTION_KEY` ensemble **seulement** si l'origine HTTPS exacte et un processus vérifié d'enrôlement/récupération MFA sont prêts. `NODE_ENV=production` ne désactive pas les routes privées. Perdre la clé peut rendre les secrets TOTP enrôlés irrécupérables.
4. Tester sur la préproduction isolée TLS/proxy/Host, accès OWNER et STAFF, refus inter-entreprises, CSRF, révisions, parcours FR/EN/mobile, sauvegarde/restauration et limites réseau. Le contrôle **anonyme et en lecture seule** `scripts/staging-readonly-preflight.js` décrit dans `docs/staging-readonly-preflight.md` n'a **pas** été exécuté contre l'hébergement public.
5. Exiger une revue indépendante de la [PR #63](https://github.com/takatakca/Facturations/pull/63) et la protection réelle de `main` ([issue #41](https://github.com/takatakca/Facturations/issues/41)) avant toute fusion. Vérifier séparément capacités/permissions Wave, correspondance des rabais et taxes, émission, PDF, courriel et paiements avec tests et autorisations appropriés.

**Aucune facture émise, aucun courriel client, paiement, appel Wave en écriture, fusion ou déploiement n'est autorisé par ces instructions.** Lire [AGENTS.md](AGENTS.md) et [l'audit #27](https://github.com/takatakca/Facturations/issues/27) avant toute modification.