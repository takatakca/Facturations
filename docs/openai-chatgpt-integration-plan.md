# Facturations AI — OpenAI / ChatGPT integration plan

Status: provider decision recorded. The intended AI provider for the Facturations assistant is OpenAI. GitHub Copilot is not part of the runtime product architecture.

## Goal

Create a bilingual FR/EN Facturations assistant that helps a user understand and operate the product while preserving deterministic financial controls.

Examples:

- “Comment créer une facture?”
- “Explique-moi ce statut.”
- “Où dois-je cliquer pour ajouter un client?”
- “Prépare un brouillon pour Client X, service Y, 850 $, payable dans 15 jours.”
- “Résume ce brouillon avant que je le soumette.”

The assistant may explain, navigate and propose structured draft changes. It may never silently issue, email, publish, record a payment, refund or recover MFA.

## Runtime architecture

```
Facturations UI
  -> Facturations AI endpoint
     -> OpenAI API
        -> structured proposal
     -> assistant-safety-gate
        -> READ_ONLY_ALLOWED / PROPOSAL_ONLY / REQUIRES_EXISTING_GATE / BLOCKED
     -> deterministic Facturations UI
```

OpenAI output is treated as untrusted input. The existing `src/assistant-safety-gate.js` remains the policy boundary after model output.

## Phase 1 — contextual help

Read-only assistant only:

- current screen identifier;
- role-safe capability list;
- short approved product help context;
- FR/EN language;
- no raw customer invoice payload required for generic help.

Allowed intent: `HELP`.

The assistant can explain buttons and workflows but cannot click or mutate on the user's behalf.

## Phase 2 — status explanation

Allow role-authorized, minimized structured status context for a single draft/document.

Allowed intent: `READ_STATUS`.

Do not send secrets, credentials, payment instruments, MFA data or unnecessary customer history.

## Phase 3 — draft proposal

The user can describe a draft in natural language. OpenAI returns a strict structured proposal containing only bounded draft fields.

The proposal must:

- be validated by deterministic server rules;
- be displayed back to the user;
- never become a saved/issued invoice without the normal user action;
- route through `DRAFT_CHANGE -> PROPOSAL_ONLY`;
- flag ambiguity instead of guessing taxes, customer identity, jurisdiction or legal issuer data.

## Phase 4 — guided actions

The assistant can point to the correct existing action and prepare confirmation context, but sensitive actions remain outside direct model execution:

- issuance -> existing OWNER issuance gate;
- delivery -> existing OWNER delivery gate;
- portal publication -> existing OWNER publication gate;
- payments/refunds -> blocked until separately approved provider workflow;
- MFA recovery -> human out-of-band only.

## Prompt injection defense

Treat all customer names, notes, imported files, PDFs, email bodies and provider text as data, not instructions.

Model-facing context must clearly separate:

- system/product instructions;
- trusted application state;
- untrusted customer/document content.

Any detected prompt-injection, multi-action request or ambiguous target is converted into a safety signal and blocked by the existing gate.

## Data minimization

Default to sending the minimum required structured fields. Do not send:

- database URLs;
- API keys;
- session cookies;
- TOTP secrets/recovery material;
- full audit logs;
- unrelated customers;
- raw payment credentials.

Log only server-generated request IDs, model/provider metadata approved for operations, latency/usage aggregates, safety decision and proposal fingerprint. Do not log the user's complete invoice prompt by default.

## Availability

Facturations must remain fully usable if OpenAI is unavailable, disabled or rate-limited. The deterministic dashboard, forms, validation, review and approval flows are primary; AI is an optional assistant layer.

## Configuration

Future implementation should use server-only environment configuration and fail closed:

- `OPENAI_API_KEY` — server only;
- `FACTURATIONS_AI_ENABLED` — explicit feature flag;
- model identifier selected in reviewed configuration;
- bounded timeout and output size;
- no API key or raw provider response exposed to the browser.

No real key belongs in GitHub, tests, screenshots or issue comments.

## Testing before activation

- French/English help;
- mobile/narrow viewport;
- model timeout/unavailable;
- malformed/non-JSON output;
- extra fields;
- prompt injection;
- multi-action request;
- ambiguous customer;
- ambiguous taxes;
- cross-tenant target;
- unauthorized role;
- attempt to issue/send/pay/refund/recover MFA;
- output containing HTML/script;
- excessive prompt/body size;
- ensure deterministic workflow works with AI disabled.

