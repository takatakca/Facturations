# Contrôle de préproduction Facturations — lecture seule

Cette étape ne déploie rien et ne valide pas à elle seule la mise en service. Elle cible uniquement `https://facturations.bolon.ca`, sur autorisation de l'exploitant **après** provisionnement d'un hébergement et d'une base Facturations distincts. Aucun secret, cookie, compte, facture ou donnée client n'est requis.

## Exécution explicite par l'exploitant

Depuis une machine avec Node.js 20+ et une connexion réseau approuvée :

```bash
node scripts/staging-readonly-preflight.js https://facturations.bolon.ca
```

Le script fait **quatre requêtes GET anonymes uniquement**, sans suivre les redirections, sans désactiver la validation TLS et sans écrire de données : `/health`, `/internal/login?lang=fr`, `/internal/recent-workspaces?lang=fr` et `/internal/workspaces/csrf`. Il exige un certificat TLS approuvé valable plus de 24 heures, HSTS ≥ 180 jours, absence de redirection/CORS permissif, `nosniff` et `no-referrer`; la santé doit identifier le service attendu, l'écran français doit contenir mot de passe et MFA, et les deux routes privées doivent répondre **401** avec protections appropriées. Les réponses sont limitées à 24 KiB et les appels expirent après 8 secondes. Une erreur produit un code de sortie non nul, sans imprimer les corps des réponses.

**Un échec n'est pas nécessairement une panne générale :** l'hôte peut ne pas être provisionné, le certificat ne pas être installé, les en-têtes HSTS manquer dans le proxy, ou les routes de cette branche ne pas encore être intégrées. Ne désactivez pas TLS, ne modifiez pas la production TAKATAK et ne remplacez pas les contrôles par des exceptions pour obtenir un résultat vert.

## Ce que ce contrôle ne prouve pas

- Ni configuration du reverse-proxy, isolation du port Node, limites de débit par IP, moindre privilège SQL, sauvegarde/restauration et journalisation expurgée.
- Ni identité ou droits d'un vrai employé, remise de l'invitation, MFA/récupération, conflit de révisions, navigation mobile ou accessibilité.
- Ni exactitude fiscale, émission Wave, PDF, courriel, paiement, portail client, ni conformité comptable.

Il faut conserver les preuves distinctes de la CI Chrome/MFA/PostgreSQL sur données fictives, de la revue indépendante, de la protection de `main` (ticket #41), des essais HTTPS réels autorisés, de la restauration de sauvegarde et de la validation fiscale avant toute décision de fusion ou de déploiement. Ne jamais copier des secrets, une sortie de base de données ou des renseignements clients dans le dépôt public ni dans une issue.

Les tests unitaires `tests/staging-readonly-preflight.test.js` valident la logique **sans contacter l'hôte**. Un résultat CI vert n'implique donc PAS que cette vérification réseau a été exécutée sur la préproduction.
