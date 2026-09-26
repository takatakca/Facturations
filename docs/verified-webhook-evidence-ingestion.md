# Ingestion de preuves SIGNED_WEBHOOK vérifiées

Cette étape autorise le ledger de preuve à enregistrer `SIGNED_WEBHOOK`, mais uniquement à partir d’une enveloppe produite par le vérificateur interne de la PR précédente.

## Barrière obligatoire

`ingestVerifiedWebhook()` refuse tout objet qui n’est pas marqué par `isVerifiedEmailWebhookEnvelope()`.

Copier les propriétés d’une enveloppe vérifiée ne suffit pas.

L’ingestion exige aussi :

- PDF qualifié exact;
- clé d’opération;
- provider key identique;
- SHA-256 du body brut présent dans l’enveloppe;
- identifiant du mécanisme de vérification;
- destinataire identique au snapshot immuable.

## Provenance persistée

La migration 022 ajoute :

- `webhook_body_sha256`;
- `verification_scheme`.

Une contrainte PostgreSQL impose :

- `SYNTHETIC_TEST` => ces champs sont NULL;
- `SIGNED_WEBHOOK` => hash SHA-256 + mécanisme de vérification obligatoires.

Le hash canonique de la preuve signée inclut ces nouvelles données.

## Tests

Les tests utilisent uniquement un vérificateur synthétique injecté.

Ils prouvent :

- objet copié/forgé => refus 403;
- enveloppe réellement produite par le vérificateur => insertion;
- body SHA-256 persisté;
- mécanisme de vérification persisté;
- idempotence;
- projection 021 => `SIGNED_WEBHOOK_PRESENT`.

## Limite importante

`SIGNED_WEBHOOK` signifie ici que **le vérificateur injecté a accepté la signature**.

Aucun algorithme d’un fournisseur commercial n’est encore implémenté ni homologué. Les tests ne constituent donc pas une preuve d’intégration réelle avec un fournisseur.

Cette étape n’ajoute toujours aucune route HTTP publique.
