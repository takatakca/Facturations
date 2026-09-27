# Version imprimable du brouillon approuvé / Printable internally approved draft

**Statut : fonctionnalité proposée dans la PR #63, non fusionnée et non déployée.** Un PDF de facture officielle, immuable et archivé n'existe pas encore.

## Parcours FR / EN

1. Le propriétaire authentifié par mot de passe et MFA crée et enregistre son brouillon de travail.
2. Il fige volontairement la version enregistrée en brouillon immuable, puis l'approuve **séparément** pour usage interne.
3. La fiche privée `/internal/review/:draftId?lang=fr` (ou `en`) affiche alors le lien « Ouvrir la version imprimable du brouillon non émis ». Le lien n'est pas affiché avant l'approbation.
4. La page `/internal/review/:draftId/print?lang=fr` (ou `en`) affiche GROUPE TAKATAK, l'indication bien visible **BROUILLON NON ÉMIS / UNISSUED DRAFT**, la référence interne UUID, le destinataire, les dates, les lignes, les rabais, les taxes saisies, les totaux et les notes. Elle fournit des règles CSS d'impression A4 et une instruction de navigateur **Imprimer → Enregistrer en PDF**.

Cette page est du HTML privé en lecture seule; **le serveur ne fabrique, ne signe, n'archive et ne livre aucun PDF**. Le PDF éventuellement sauvegardé par le propriétaire dans son navigateur est une copie locale non officielle et n'est pas conservé par Facturations. La référence UUID n'est **pas** un numéro de facture. Un enregistrement papier ou PDF manuel ne doit pas être traité comme une facture fiscale.

## Contrôles

- Route `GET` seulement, session `__Host-facturations-session` vérifiée dans PostgreSQL, rôle `OWNER` actif, correspondance de l'entreprise et approbation interne persistée vérifiée **avant** de charger le brouillon.
- Pas de jeton admin ni bearer, `Cache-Control: private, no-store`, CSP sans script ni connexion externe, aucune donnée client dans les URL ou journaux.
- Les montants sont recalculés depuis les champs immuables et comparés aux totaux stockés; une divergence refuse l'affichage. Texte client échappé, aucune mutation de facture, de Wave ou de courriel.
- Les champs de taxes sont ceux qui ont été saisis et **ne sont pas certifiés conformes**. Ne pas ajouter un taux fiscal implicite.

## Vérifications et limites

`tests/browser-owner-print.test.js` teste le rendu FR/EN, les refus sans session/STAFF/non approuvé, une lecture PostgreSQL après approbation explicite et l'absence de changement d'état. `tests/owner-print-navigation.test.js` vérifie que le lien n'apparaît qu'après approbation. Les suites Chrome historiques ne constituent **pas** un test visuel des pages imprimées ni une validation PDF. Avant un PDF officiel, il faut un moteur PDF, les mentions légales et données d'entreprise vérifiées, la numérotation, l'archivage immuable, l'accès privé, une revue fiscale et des tests de rendu multipages/accentuation.
