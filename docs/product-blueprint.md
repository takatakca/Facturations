# GROUPE TAKATAK — Facturations: product blueprint

**Status:** design specification. These features are NOT implemented or deployed unless explicitly identified in the README. Business owner approves final business, legal, branding, payment and hosting decisions.

## Product principle

One independent invoicing service at `facturations.bolon.ca` with two distinct experiences: (1) authenticated internal workspace for GROUPE TAKATAK staff and (2) narrowly scoped client portal. Wave remains the official accounting/invoice source of truth once a draft is issued. The internal database stores pending drafts, customer mapping, approval records, consent, delivery events and audit history; it must not silently duplicate ledger transactions. Existing `takatak.ca` production services are off-limits during development.

## End-to-end user journey

1. Owner types or dictates: “Draft an invoice for [customer] for [service] at [amount], with [terms].” Transcription and language understanding must produce **structured, untrusted proposed fields**, never direct accounting mutations.
2. Identity lookup matches customer records by verified source IDs, with a review when email/name are ambiguous; a new customer is saved only with an authorized action. Collect the minimum necessary information and record its source.
3. Backend validates customer, business, currency, line items, dates, tax treatment and amounts; displays a full PDF-like preview, totals, payment instructions and an explicit “Draft only” state. Do not infer taxable status, registration numbers, exemptions, tax rates or tax jurisdiction from the model.
4. Owner reviews the exact customer, email, total, items, applicable taxes and due date. **Explicit confirmation is required separately for issuance and email delivery**. Changes after review invalidate approval.
5. Issue via supported Wave API only after verified capabilities and authorization. Use a stored idempotency key, immutable issued snapshot, authoritative Wave ID, reconciliation and retry logic. Never silently issue a second invoice on timeout.
6. Deliver an approved PDF or Wave-hosted link by an authorized email provider; record recipient, provider message ID, attempt, status and redacted error. A failed email must not silently recreate the invoice.
7. Client receives a secure invitation or preexisting TAKATAK-identity login, sees only **their** invoices and receipts, and can update limited profile details. A customer edit is a request/review or a separate customer-record update; issued invoice details remain immutable and corrections use proper credit/reissue workflow.
8. Payment status must come from verified Wave/processor records, not an AI interpretation, client-edited field or email open event. Reconcile refunds, partial payments, overpayments and disputes.

## Permission model and portals

- Roles: OWNER, ACCOUNTANT/STAFF (explicit scoped grants), CLIENT (only linked, verified customer accounts). Default deny. No anonymous invoice lookup by sequential invoice number.
- Reuse TAKATAK central identity **only after** a reviewed secure integration; never automatically create accounts or associate cross-brand identities just because names or unverified emails match.
- For clients without TAKATAK accounts, use one-time, random, expiring invitation tokens; store only token hashes, enforce one-time use, per-account throttling and safe recovery. Verify email ownership before allowing portal access.
- Server-side session cookies must be Secure, HttpOnly, SameSite and rotated; CSRF protection for state changes, server-side authorization on every request, brute-force and abuse controls, MFA for privileged roles, device/session revocation, accessible account recovery.
- Every database read/write uses a verified `business_id` **and** authenticated principal/customer mapping. Add and test database row-level security or equally strong enforced tenant isolation before exposing portal routes. Never expose an administrator key in frontend JavaScript.
- Client portal: invoice list/status, download verified PDFs, payment history, secure support requests, profile update requests and email preferences. Only issued/authorized documents are client-visible. Limit visibility across brands, locations and client organizations.

## Data model evolution

Existing Phase 3: `invoice_customers`, `invoice_drafts`, `invoice_audit_events` (create-only). Later migrations (NOT present): `identities`, `business_memberships`, `client_memberships`, `invoice_approvals`, `issued_invoices`, `invoice_deliveries`, `payment_events`, `credit_notes`, `file_assets`, `consent_records`, `provider_sync_events` and a transactional outbox. Version migrations; never rewrite history in place.

- Unique external IDs per provider/business, idempotent incoming events, irreversible external side effects guarded by a state machine.
- Draft -> READY_FOR_REVIEW -> APPROVED -> ISSUING -> ISSUED -> DELIVERY_PENDING -> SENT/DELIVERY_FAILED; provide manual repair, cancellation and credit-note paths where supported. No arbitrary API route may skip these transitions.
- Store issued document fingerprints and immutable snapshots; do not use customer edits to rewrite invoices already delivered.
- Encrypted data at rest, database least privilege, backups and tested restores, retention/deletion rules reviewed with legal/accounting professionals, audit events without raw secrets.

## Practical feature checklist

**Internal:** client search/merge review, quote-to-invoice draft, line catalogue, editable drafts, optional installments/recurring schedules with separately authorized billing, branded FR/EN templates, optional ES, taxes by verified business rule, deposits, credits, attachments, invoice numbering controlled by Wave, aging summaries, payment reconciliation, export and error dashboard.

**Assistant:** text/voice input, attachment extraction with consent, evidence-linked proposed fields, uncertainty/ambiguity prompts, edit-and-confirm preview, no silent email or payment actions, audit of approval (without raw credentials), multilingual confirmation of amounts and recipient. A ChatGPT conversation requires a separately built and authorized ChatGPT-to-TAKATAK integration; merely having an OpenAI API key does not make this chat an API client.

**Client:** verified login/invitation, downloadable invoices and receipts, accessible/mobile-first UI, account contacts for organizations, payment history, dispute/support form, optional payment method through a processor-hosted flow (never store card numbers), explicit communication preferences.

**Delivery:** provider retry queue, unique send attempt IDs, bounce/rejection handling, DKIM/SPF/DMARC, safe PDF generation, no secrets in URLs, verified business sender domain and receipt of provider message IDs.

**Operations:** staging separate from production, automated mocked and disposable-DB integration tests, real Wave read-only smoke test, feature flags for each external side effect, code review, backup/restore and disaster recovery, monitoring without sensitive logs, independent MochaHost deployment checklist. Avoid hard-coded promises about Wave feature access before current API capability is verified.

## Release gates (cannot be skipped)

1. Confirm hosting/DNS/SSL and dedicated database. Isolated staging only.
2. Implement proper staff authentication before using any browser UI with personal invoice data. Replace temporary admin header for interactive use.
3. Verify applicable tax rules and invoice content with an accountant, actual Wave API methods and subscription permissions with Wave docs, and email/privacy requirements before enabling production sending.
4. Test user/customer cross-tenant access, concurrent idempotency, authorization, expiry, provider timeouts, partial failures, duplicate webhooks, PDF downloads, backups and restores.
5. Conduct a supervised end-to-end trial using authorized test customers and review before turning on real issuance and email. Keep a rollback plan and never modify existing TAKATAK production deployments without separate approval.
