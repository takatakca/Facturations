# Assistant IA / voix — contrat de sécurité provider-neutral

L’assistant n’est jamais une autorité d’émission, d’envoi, de paiement, de publication ou de récupération MFA.

Cette couche traite la sortie d’un futur modèle IA ou moteur voix comme **non fiable**. Aucun fournisseur réel n’est intégré ici.

## Enveloppe structurée seulement

Le gate accepte uniquement une enveloppe versionnée avec :

- source `TEXT` ou `VOICE`;
- une seule intention allowlistée;
- confiance en points de base;
- une cible typée;
- preuve de transcription hachée pour la voix;
- signaux de sécurité allowlistés.

Tout champ supplémentaire est rejeté. Un provider ne peut donc pas injecter dans l’enveloppe :

- confirmation;
- tool call;
- side effect;
- moyen de paiement;
- transcription brute;
- secret.

## Décisions

### Lecture seule

`HELP` et `READ_STATUS` peuvent être classés `READ_ONLY_ALLOWED`.

Même là, `directExecutionAllowed` reste toujours `false`: le gate ne possède aucune fonction d’écriture.

### Modification de brouillon

`DRAFT_CHANGE` produit uniquement `PROPOSAL_ONLY`.

L’utilisateur doit revoir la proposition dans l’éditeur normal avant toute mutation.

### Actions sensibles

- `ISSUE_INVOICE` → gate existant `AUTHORIZE_ISSUANCE_PENDING_PROVIDER`;
- `DELIVER_INVOICE` → gate existant `AUTHORIZE_QUALIFIED_PDF_DELIVERY`;
- `PUBLISH_PORTAL` → autorisation OWNER de publication existante.

L’assistant ne peut pas satisfaire lui-même ces gates.

### Toujours bloqué

- `RECORD_PAYMENT`;
- `REFUND_PAYMENT`;
- `MFA_RECOVERY`.

Les opérations financières réelles restent bloquées tant qu’un provider réel n’est pas homologué. La récupération MFA reste exclusivement `HUMAN_OUT_OF_BAND`.

## Voix

Une intention voix exige :

- SHA-256 de la transcription;
- longueur;
- langue FR/EN;
- confiance minimale supérieure à celle du texte.

La transcription brute n’est ni nécessaire au gate ni retournée par lui.

## Prompt injection et ambiguïté

Les signaux suivants bloquent immédiatement :

- `PROMPT_INJECTION`;
- `MULTI_ACTION`;
- `AMBIGUOUS_TARGET`;
- `UNVERIFIED_TRANSCRIPT`.

Une empreinte SHA-256 déterministe lie la proposition normalisée à sa source, son intention, sa cible et sa preuve de transcription. Toute confirmation humaine ultérieure doit porter sur l’objet exact affiché, jamais sur du texte libre réinterprété.

## Frontière production

Ce module n’intègre ni OpenAI, ni moteur STT/TTS, ni fournisseur de paiement, ni Wave write, ni fournisseur email. Avant activation réelle, le gate `ai_voice_safety_validation` du GO/NO-GO exige encore une revue sécurité indépendante et des tests adversariaux sur le fournisseur réellement choisi.
