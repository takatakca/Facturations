# Facturations — Décisions et contraintes

Historique de décisions techniques observées, arrêté au **2026-10-14**. Ce document distingue expressément les décisions déjà inscrites au dépôt des propositions encore soumises à revue.

| ID | Décision/contrainte | Source | État |
| --- | --- | --- | --- |
| D-001 | Facturations reste une application autonome FR/EN distincte du tableau de bord général GROUPE TAKATAK. | `AGENTS.md`, `docs/product-blueprint.md` | Adoptée en architecture |
| D-002 | Identité TAKATAK maître, mais appels serveur-à-serveur signés, droits OWNER/STAFF et `business_id` validés par Facturations; jamais de secrets dans le navigateur. | `docs/takatak-dashboard-integration-handoff-v1.md` | Contrat du code actuel; homologation réelle en attente |
| D-003 | Brouillon → revue humaine → autorisation d'émission → livraison explicitement et séparément autorisée. Aucune IA ne déclenche l'émission ou l'envoi. | `AGENTS.md`, `README.md` | Invariant obligatoire |
| D-004 | PostgreSQL isolé, migrations append-only, privilèges minimaux et restauration testée; jamais de modifications des autres bases TAKATAK. | `AGENTS.md`, `docs/staging-go-no-go.md` | Obligatoire |
| D-005 | SHA exact, CI, approbation indépendante, staging HTTPS et GO/NO-GO réel précèdent la production. | `docs/final-go-live-runbook.md` | Obligatoire |
| D-006 | Les données Stripe synthétiques et `SIMULATED_EMAIL` ne constituent jamais une preuve de paiement réel ou de livraison. | `docs/stripe-verified-payment-webhook.md`, `README.md` | Obligatoire |
| D-007 | Aucun écrasement de `main`, aucun force-push destructif; changements via branches et PR compatibles avec la protection constatée. | `AGENTS.md`; GitHub `main` protected | Obligatoire |
| D-008 | Ajouter cinq documents de relève et une vérification CI sans activer de fonctionnalités financières. | Demande de reprise du 2026-10-14 | En PR |

## À ne pas considérer comme décidé

- **Plateforme du staging/production :** MochaHost et la proposition Coolify/Contabo #159 coexistent dans les documents; aucun déploiement constaté.
- **Activation Wave réelle :** aucune autorisation transactionnelle, preuve de réconciliation ni validation d'un compte de test n'est constatée.
- **Fournisseur email et consentement client :** non homologués; les actions externes restent désactivées.
- **Environnement Stripe réel et remboursements :** le traitement de preuves webhook n'autorise pas de créer ou rembourser une transaction.
- **Conformité légale/fiscale et rétention :** revue indépendante exigée; ne jamais inventer de numéro de taxes ou de certification.

## Procédure pour consigner une nouvelle décision

Ajouter la date, l'ID, la décision effectivement autorisée, ses implications de sécurité, sa source (PR/issue/runbook) et le SHA pertinent. Ne pas transformer une recommandation d'agent en décision du propriétaire sans preuve.
