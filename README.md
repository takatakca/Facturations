# GROUPE TAKATAK — Facturations

**Status: development / NOT ready for real customers or invoicing.** Independent Node.js application intended for a NEW, isolated `facturations.bolon.ca` hosting environment only after MochaHost confirms its DNS, HTTPS and dedicated application. No real Wave connection, production deployment, client enrollment or invoice send has been verified. The repository is PUBLIC: never commit `.env`, passwords, access tokens, real customer information, invoices, database dumps or logs.

The single source of truth for remaining blockers and verified work is [the readiness audit](https://github.com/takatakca/Facturations/issues/27). `docs/product-blueprint.md` and `docs/first-run-guidance.md` describe planned work, NOT delivered features. A passing CI run is not an end-to-end release sign-off.

## Implemented, with important boundaries

- CAD-only deterministic preview, with bounded line items and user-supplied tax definitions; tax applicability and fiscal correctness are **not** automatically determined.
- Tenant-scoped PostgreSQL customer records, immutable and idempotently saved **draft snapshots**, draft-only summary/listing, owner-only customer directory and internal approval ledger. No editable draft revisions or recoverable autosave yet; a customer's directory profile may retain older details while each draft preserves its own recipient snapshot.
- Trusted backend foundations for staff accounts, invitations, hashed/revocable sessions, encrypted TOTP and email-scoped PostgreSQL login throttling. Invitations are **not** delivered or recovered automatically; no production enrollment process is available.
- An **opt-in** bilingual FR/EN browser sign-in and sign-out with password + activated TOTP, exact configured HTTPS Origin/Host checks and a Secure/HttpOnly/SameSite=Strict session cookie. The cookie authorizes ONLY the read-only HTML dashboard at `/internal/dashboard`, not `/api/*` or Wave writes. Requires a separate database, private TOTP key and explicit HTTPS origin. It does not prove TLS/proxy/IP protection is correctly configured on an actual host.
- A fixed, read-only Wave GraphQL business-list query, if privately configured. This is **not** an OAuth callback, live connection verification, invoice issuance or synchronization.

**Not implemented / not verified:** full draft editor and revision-safe autosave, owner approval interface, Wave invoice creation/reconciliation, invoice PDF/email/payment tracking, authenticated customer portal, AI/voice assistant, secure self-service onboarding/recovery, backups/restores, complete tax review and independent browser/staging tests. Internal draft approval service is not exposed by the browser or HTTP routes. No actual invoice number, revenue or payment status is produced.

## Local development and disposable tests

Requirements: Node.js 20.11+ (Node 22 also tested), npm and an isolated PostgreSQL 16 instance **only for integration tests or a separately authorized Facturations database**. From a fresh checkout:

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
cp .env.example .env
```

The repository currently lacks a committed `package-lock.json`; installation is NOT yet fully reproducible. Track this gap in audit #27. GitHub Actions runs the syntax gate and tests on Node 20/22 with disposable PostgreSQL 16; integration tests require `FACTURATIONS_TEST_DATABASE_URL` and the setup script rejects anything other than a local `facturations_test` database. Do not run migrations or tests on existing TAKATAK production data.

For *local development only*, keep `.env` private; use `npm run dev` and inspect `http://127.0.0.1:3000/health`. An empty `TAKATAK_ADMIN_KEY` means private admin routes are unavailable. If used for isolated server-to-server tests, generate a new random value privately (for example `openssl rand -hex 32`). **Never put `X-Admin-Key`, Wave tokens or database credentials in a browser or mobile app.** Do not reuse previously exposed credentials.

## Available routes and access

| Method | Route | Current behavior |
| --- | --- | --- |
| GET | `/health` | Minimal public process response; not production readiness |
| GET | `/internal/login?lang=fr` or `en` | Bilingual sign-in form, only if explicitly configured |
| POST | `/internal/login` and `/internal/logout` | MFA sign-in/session revocation; exact Origin/Host checks, only if configured |
| GET | `/internal/dashboard?lang=fr` or `en` | Read-only draft dashboard; staff bearer or valid browser session cookie |
| GET | `/api/dashboard/summary`, `/api/drafts` | Draft-only summary and paginated listing; staff bearer or private admin header |
| GET | `/api/drafts/:uuid`, `/api/customers`, `/api/approvals` | Full draft, contacts and internal approvals; OWNER bearer or private admin header |
| POST | `/api/drafts/preview`, `/api/drafts` | Private admin header only; preview or save a DRAFT with `Idempotency-Key` |
| GET | `/api/wave/businesses` | Private admin header only; read-only Wave business list |

Browser cookies never authorize `/api/*`. For new drafts, submit JSON `Content-Type: application/json` within the 32-KiB limit. The `Idempotency-Key` is 16–80 letters/numbers/underscores/dashes; retries with the same key and different content return 409. A draft is **never** an invoice sent to Wave.

Example entirely fictional preview payload:

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

The preview recalculates integer minor-unit totals and labels them `PREVIEW_ONLY`; saved records remain `DRAFT` with `waveSynced: false` and `emailed: false`. Tax rules, registration and rounding must be reviewed by the responsible qualified professionals before real issuance.

## Isolated database and browser sign-in: NOT a deployment procedure

1. Have MochaHost confirm a separate Node application/root, external HTTPS and trusted TLS reverse proxy with the raw Node port inaccessible. Add trusted-edge per-IP throttling and verify canonical Host handling. Do not modify an existing GROUPE TAKATAK service.
2. Provision a **NEW** Facturations-only database and least-privilege runtime role; review and apply migrations `db/001` through `db/007` in numeric order **only there** using a controlled migration process, not against an existing TAKATAK database. Arrange encrypted backups, restoration testing, retention and restricted access before real data.
3. Set `FACTURATIONS_DATABASE_URL` and `WAVE_BUSINESS_ID` privately **together** for storage. Set `FACTURATIONS_PUBLIC_ORIGIN` and `FACTURATIONS_TOTP_ENCRYPTION_KEY` privately **together** only once HTTPS staging and a verified invitation/MFA provisioning and recovery procedure are ready. The origin must be the exact external HTTPS origin without a path or trailing slash; the TOTP key must be a separately generated random 32 bytes in hexadecimal. Losing the key can make enrolled MFA secrets unrecoverable. See `docs/browser-staff-login.md` and `.env.example` for documented boundaries, NOT ready-to-paste credentials.
4. Test owner/staff onboarding, every role/tenant denial, MFA/replay/expiry, browser sign-in/out, CSP and CSRF, failures, accessibility, mobile display and encrypted backup restoration on the isolated staging host. Verify Wave separately using an explicitly authorized isolated account. **Do not issue invoices, send emails, accept payments or expose a client portal without specific owner authorization and the audit completion gates.**

This README records repository capabilities, not confirmation that `facturations.bolon.ca` exists or is operational. Review [AGENTS.md](AGENTS.md) and [audit #27](https://github.com/takatakca/Facturations/issues/27) before any further change.
