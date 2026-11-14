# GROUPE TAKATAK — Facturations

**Application en développement, non déployée : aucune facture réelle ne doit être émise.** Le dépôt est public : ne jamais y placer des secrets, données clients, factures, sauvegardes ou journaux sensibles. Facturations exige un hébergement et une base PostgreSQL exclusivement dédiés, sans toucher aux services TAKATAK existants. Ni le site `facturations.bolon.ca` ni Wave réel n'ont été homologués. Les fonctionnalités décrites ci-dessous sont **proposées dans la [PR #63](https://github.com/takatakca/Facturations/pull/63)** et ne figurent pas toutes sur `main`.

## Parcours interne proposé

Connexion privée FR/EN du personnel avec mot de passe, MFA TOTP et session révocable; tableau de bord, éditeur mobile, recherche et historique des brouillons de travail. La sauvegarde automatique intervient après trois secondes sans saisie, côté serveur et avec révisions; elle n'est pas garantie lors d'une fermeture prématurée, d'une panne, d'un conflit entre onglets ou d'une perte de réseau. L'aperçu est calculé en cents, CAD seulement, avec taxes explicitement saisies — **aucune décision fiscale automatisée**.

Le propriétaire peut figer volontairement une révision enregistrée en brouillon immuable PostgreSQL, puis l'approuver **séparément en interne seulement**. Après cette approbation, une troisième décision distincte peut enregistrer une **autorisation d'émission en attente du fournisseur** (`AUTHORIZED_PENDING_PROVIDER`) en revérifiant destinataire et total. Cette autorisation est immuable et idempotente, mais elle ne modifie pas le brouillon : `issued=false`, `waveSynced=false`, `emailed=false`. Aucun appel Wave n'est effectué. Les anciens liens d'édition d'un brouillon figé redirigent le propriétaire vers sa révision; un onglet ancien reçoit HTTP 409 à la sauvegarde. La fiche approuvée propose aussi une version privée A4 FR/EN **BROUILLON NON ÉMIS / UNISSUED DRAFT** que le navigateur peut imprimer ou enregistrer en PDF. Ce document n'est ni une facture officielle numérotée ni un PDF immuable archivé par le serveur. Voir également [`docs/owner-issuance-authorization.md`](docs/owner-issuance-authorization.md).

Le répertoire clients privé FR/EN est réservé au propriétaire : consultation, recherche par nom/courriel sans les mettre dans l'URL, pagination, **ajout de clients et correction de coordonnées**. Les changements sont contrôlés par session/CSRF/origine, inscrits en transaction PostgreSQL avec révision et journal sans duplication des coordonnées; une fiche concurrente ou un courriel déjà enregistré entraîne 409. Les copies immuables des brouillons ne changent **jamais** lorsque le répertoire est corrigé. Voir [`docs/owner-customer-directory.md`](docs/owner-customer-directory.md), [`docs/owner-customer-contacts.md`](docs/owner-customer-contacts.md) et [`docs/owner-printable-draft.md`](docs/owner-printable-draft.md).

Les cookies navigateur n'autorisent aucune écriture `/api/*` ni action Wave. Le connecteur Wave existant ne propose qu'une lecture de la liste des entreprises avec un jeton autorisé. `src/wave-issuance-preflight.js` construit seulement un plan local sans réseau après vérification stricte des mappings client/produits/taxes et refuse les rabais par ligne plutôt que de les approximer. Le moteur fournisseur persiste ensuite une tentative avec une clé d'opération stable et les états `PREPARED`, `IN_PROGRESS`, `AMBIGUOUS`, `CONFIRMED` ou `FAILED`. Un état ambigu bloque tout nouvel appel jusqu'à réconciliation explicite. Après un résultat `CONFIRMED`, un registre local append-only peut matérialiser séparément `ISSUED_CONFIRMED` avec l'identifiant fournisseur et le numéro officiel tout en gardant `delivery_state=NOT_AUTHORIZED`; le brouillon source reste `DRAFT`. L'adapter est injecté : ce dépôt n'appelle toujours aucune API Wave en écriture. Voir [`docs/issued-invoice-registry.md`](docs/issued-invoice-registry.md). Une facture `ISSUED_CONFIRMED` peut ensuite produire une archive PDF bilingue déterministe, hachée SHA-256 et stockée en `bytea`, toujours avec `delivery_state=NOT_AUTHORIZED`; voir [`docs/immutable-issued-invoice-pdf.md`](docs/immutable-issued-invoice-pdf.md). L’identité légale/fiscale de l’émetteur est préparée séparément sous forme de versions immuables, avec vérification OWNER explicite; voir [`docs/verified-issuer-profile.md`](docs/verified-issuer-profile.md). Chaque archive PDF complète est ensuite liée transactionnellement à l’ID, au hash et au snapshot exacts d’une version émetteur déjà vérifiée; voir [`docs/pdf-issuer-profile-binding.md`](docs/pdf-issuer-profile-binding.md). La permission d’envoyer est encore séparée : un OWNER peut autoriser par un registre append-only un PDF exact, un destinataire, un numéro officiel et les hashes document/profil sans déclencher aucun courriel; voir [`docs/document-delivery-authorization.md`](docs/document-delivery-authorization.md). La configuration d'une origine HTTPS dans Node ne prouve pas à elle seule la présence d'un certificat ni d'un proxy sécurisé.

**Non livrés ou non vérifiés :** première exécution Wave réelle autorisée, réconciliation contre un compte Wave réel, profil légal/fiscal d’émetteur homologué, autorisation de livraison/envoi client, paiements/remboursements, portail client, assistant IA/vocal, récupération MFA, restauration sauvegarde, revue fiscale/comptable et homologation TLS publique. Le registre local `ISSUED_CONFIRMED` ne constitue pas à lui seul une preuve indépendante qu'une facture existe réellement chez Wave. Le parcours Chrome isolé couvre maintenant MFA → autosauvegarde → conversion immuable → approbation interne → impression non émise; il ne prouve ni le staging public ni le nouveau formulaire client dans Chrome.

## Installation de développement et base de tests jetable

Node.js >=20.11, npm, PostgreSQL 16 **local et jetable uniquement** pour les tests d'intégration. Depuis une extraction propre :

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
cp .env.example .env
```

`package-lock.json` est présent. Pour les tests PostgreSQL, `FACTURATIONS_TEST_DATABASE_URL` doit pointer exclusivement vers `localhost` ou `127.0.0.1` et la base `/facturations_test`; ne jamais définir `FACTURATIONS_DATABASE_URL` dans le processus de test. Vérifier la cible avant `node scripts/setup-test-db.js`. Ce script applique uniquement dans cette base jetable les migrations **001 à 017**, dont 008 (espaces révisables), 009 (conversion immuable), 010 (révision/journal des fiches clients), 011 (autorisation d'émission), 012 (tentatives fournisseur persistées), 013 (émissions confirmées), 014 (archive PDF immuable), 015 (profil émetteur vérifié), 016 (binding PDF ↔ profil) et 017 (autorisation OWNER de livraison). La CI exécute `npm ci`, audit production, `npm run check`, `npm test` sous Node 20/22 et des parcours Chrome séparés avec données fictives.

Pour le mode local non connecté, garder `.env` privé, lancer `npm run dev` puis consulter `http://127.0.0.1:3000/health`. Sans `TAKATAK_ADMIN_KEY`, les routes administratives privées restent indisponibles. Ne placer aucun secret ou jeton Wave dans le navigateur.

## Routes principales proposées

| Méthode | Route | Portée |
| --- | --- | --- |
| GET | `/health` | Processus vivant uniquement |
| GET / POST | `/internal/login?lang=fr\|en` | Connexion et MFA, si configuration complète |
| POST | `/internal/logout` | Révocation de session |
| GET | `/internal/dashboard?lang=fr\|en` | Tableau de bord privé |
| GET | `/internal/editor?lang=fr\|en` | Éditeur, option `id` pour reprendre |
| GET / POST | `/internal/recent-workspaces?lang=fr\|en` | Historique/recherche privés |
| GET / POST | `/internal/customers?lang=fr\|en` | Répertoire propriétaire, recherche POST sans noms dans l'URL |
| GET / POST | `/internal/customer-contact?lang=fr\|en` | Création de contact OWNER; option `id` pour correction avec révision |
| GET | `/internal/workspaces/csrf` | Jeton CSRF lié à la session |
| POST / GET / PUT | `/internal/workspaces`, `/internal/workspaces/:uuid` | Création, chargement et sauvegarde révisée |
| GET | `/internal/workspaces/:uuid/preview?lang=fr\|en` | Aperçu non émis |
| GET / POST | `/internal/submit/:uuid?lang=fr\|en` | Soumission OWNER explicite, non approuvée automatiquement |
| GET / POST | `/internal/review/:uuid?lang=fr\|en` | Approbation interne OWNER uniquement |
| GET / POST | `/internal/review/:uuid/authorize-issuance?lang=fr\|en` | Autorisation OWNER distincte, état interne `AUTHORIZED_PENDING_PROVIDER`, aucun appel Wave |
| GET | `/internal/review/:uuid/print?lang=fr\|en` | Document imprimable privé, non émis |
| GET / POST | `/internal/review/:uuid/authorize-issuance?lang=fr\|en` | Autorisation OWNER immuable, en attente du fournisseur; aucune émission ni Wave |
| GET | `/internal/review?lang=fr\|en` | Liste de brouillons immuables |
| GET | `/api/wave/businesses` | Administrateur serveur, lecture seule |

Les routes `/api/*` restent séparées des cookies navigateur; un UUID n'est jamais une autorisation. Une modification du répertoire clients ne modifie pas les anciennes factures en préparation.

## Conditions AVANT toute fusion ou préproduction

1. L'exploitant doit confirmer une application et une base **Facturations seules**, DNS/certificat HTTPS publics, proxy de confiance, port Node inaccessible directement, limitation IP et comptes SQL à droits minimaux. Ne pas toucher aux services TAKATAK existants.
2. Faire examiner et appliquer sur cette **seule base dédiée** les migrations `db/001` à `db/017`, dans l'ordre, avec plan de sauvegarde chiffrée et preuve de restauration avant données réelles. Les migrations 010 à 017 couvrent les contacts audités, l'autorisation d'émission, le suivi fournisseur, la matérialisation locale confirmée, l'archive PDF immuable, le profil émetteur vérifié, son binding documentaire et l'autorisation de livraison séparée.
3. Conserver `FACTURATIONS_DATABASE_URL`, `WAVE_BUSINESS_ID` et la clé secrète `FACTURATIONS_TOTP_ENCRYPTION_KEY` hors du dépôt; configurer `FACTURATIONS_PUBLIC_ORIGIN` uniquement sur le HTTPS exact et après une procédure fiable d'enrôlement/récupération MFA. `NODE_ENV=production` ne masque pas les routes privées.
4. Vérifier sur staging isolé TLS/proxy/Host, refus STAFF/inter-entreprises, CSRF, révisions, formulaires FR/EN/mobile, sauvegarde/restauration et impression fictive; le préflight lecture seule `scripts/staging-readonly-preflight.js` n'a pas été lancé contre le site public.
5. Exiger la revue humaine indépendante de la [PR #63](https://github.com/takatakca/Facturations/pull/63) et la protection effective de `main` ([issue #41](https://github.com/takatakca/Facturations/issues/41)) avant fusion. Tester séparément autorisations et mappings Wave, émission, PDF, courriel, paiements et fiscalité.

**Aucune facture réelle, aucun courriel client, paiement, appel Wave en écriture, fusion ou déploiement n'est autorisé par ce document.** Lire [AGENTS.md](AGENTS.md) et [l'audit #27](https://github.com/takatakca/Facturations/issues/27) avant tout changement.
