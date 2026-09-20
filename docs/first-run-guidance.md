# First-run guidance and recoverable drafting — product acceptance criteria

Status: specification only; no UI, autosave, AI, telemetry, or production feature is implemented by this document.

## Outcome
A first-time staff member can identify the dashboard, begin a draft, recover interrupted work, review it, and understand that issuing and sending are separate owner-approved actions. The experience is bilingual (FR/EN), mobile-first, accessible, and intentionally restrained rather than an AI-styled visual spectacle.

## Guided experience
1. On the first authenticated visit, offer a dismissible introduction explaining the dashboard and its draft-only figures. Never describe draft totals as revenue, paid amounts, or issued invoices.
2. Highlight the real New draft action only once that route exists and is authorized; do not render a dead-end button. Explain customer selection, line items, review, and the explicit save status in context.
3. Explain the approval queue only when it exists and the current staff role can access it. Issuing and emailing require distinct explicit owner confirmations; a tour must never trigger either action.
4. Provide persistent Help / Replay tour, Back, Next, Skip, and Finish controls. Dismissal or completion must not prevent the user from accessing help again. No blocking modal for routine return visits.
5. Use short FR/EN copy, clear focus indication, keyboard-accessible controls, semantic dialog/step labels, and reduced-motion support. The guide must work at narrow mobile widths and with screen readers.
6. Contextual explanations must be tied to stable feature identifiers, not fragile CSS selectors or hard-coded screen coordinates. If a feature is absent, skip its step rather than highlighting unrelated UI.

## Recoverable drafts
1. Server-side autosave is opt-in only after authenticated, business-scoped draft editing and revision APIs exist. Persist bounded validated draft data to the isolated Facturations database, not persistent plaintext browser storage.
2. Show Saving / Saved / Offline or failed / Conflict states truthfully. Never claim Saved before the server acknowledges the revision.
3. Debounce edits; use a revision or compare-and-swap token so two tabs or users cannot silently overwrite newer work. On conflict, preserve the unsaved edits in the current session and offer an explicit reconciliation path.
4. Restore the last acknowledged draft after refresh, navigation, session renewal, or an interrupted connection, subject to authorization. A revoked or expired session cannot read or save drafts.
5. Autosave never issues invoices, sends email, invokes Wave writes, or approves a draft. No real customer data in fixtures, public logs, analytics, URLs, or browser persistence.

## Tests required before delivery
- First visit, returning visit, replay, skip, missing-feature step, FR/EN, narrow viewport, keyboard and screen-reader behavior.
- Unauthenticated, revoked, wrong-business, wrong-role, CSRF and cross-origin denial before any draft read/write; verify no cross-tenant leakage.
- Rapid edits, failed write, network interruption, reload, concurrent tabs, stale revision conflict, oversized payload, malformed content, XSS and prompt-injection text treated as data.
- Ensure no guide or autosave action issues an invoice, sends a message, charges a payment, or changes existing production systems.

## Delivery sequence
Finish and verify staff authentication and business isolation (issue #3); connect an authenticated dashboard (issue #10); add the smallest usable guided dashboard increment; then implement revision-safe server autosave in a separate PR. Verify Node 20/22 CI and isolated PostgreSQL tests for each change. An AI conversational invoice assistant is a separate, later, explicitly authorized integration: deterministic forms and safe drafts must work without it.
