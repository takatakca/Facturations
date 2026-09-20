# GROUPE TAKATAK — Facturations

**Phase 3 development:** isolated Node.js Wave read-only connector, deterministic CAD invoice previews, and opt-in PostgreSQL customer/draft persistence. This application is intended for `facturations.bolon.ca` **after MochaHost confirms a separate hosting environment**. It has not been deployed or connected to a real Wave business or database.

**Important limits:** Saved drafts are NOT issued invoices. No Wave invoice creation, customer invitations, client portal login, PDF creation, payment collection, AI commands, email sending or OAuth callback exists yet. No automatic deployment. The repository is **public by the owner's choice**: never commit secrets, `.env`, client records, invoices, database snapshots or logs.

## Development and tests

Requirements: Node.js 20.11+ or Node.js 22 and a separate PostgreSQL 16 database for real draft storage. From a checkout:

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
cp .env.example .env
```

Generate a random administrator key with `openssl rand -hex 32`. Add it privately to `TAKATAK_ADMIN_KEY` and add a newly created Wave personal access token to `WAVE_ACCESS_TOKEN` only on the machine/server running the app. **Do not reuse or publish previously disclosed secrets.** Start with `npm run dev` and check `http://127.0.0.1:3000/health`.

The `X-Admin-Key` mechanism is temporary **server-to-server/testing authentication**, NOT a login system for browsers or clients. Never embed it in a webpage, mobile app, URL or screenshot. The public `/health` response contains no customer data or credentials.

## Endpoints and safeguards

| Method | Route | Description |
| --- | --- | --- |
| GET | `/health` | Public minimal health response |
| GET | `/api/wave/businesses` | Administrator header; reads accessible Wave businesses only |
| POST | `/api/drafts/preview` | Administrator header; validates/calculates a stateless draft preview |
| POST | `/api/drafts` | Administrator header + `Idempotency-Key`; saves a draft **only if a dedicated database is configured** |
| GET | `/api/drafts/:uuid` | Administrator header; retrieves a saved draft in the configured business only |
| Other | `/oauth/callback`, `/api/invoices`, `/api/email`, `/portal` | Not implemented; returns 404 |

All submitted draft JSON uses `Content-Type: application/json` and a 32-KiB request limit. The `Idempotency-Key` must be 16–80 letters, numbers, underscores or dashes; reuse the same key for retries of **exactly the same draft**. Reusing it for changed content gives HTTP 409. No Wave API write is triggered by any draft route.

The pure preview calculator accepts **CAD only**, up to 50 line items and three explicitly provided tax definitions. Quantities and prices are whole integers/cents; independent taxes on a common taxable base are rounded half up per tax with integer arithmetic. **No tax rate or jurisdictional applicability is assumed**; confirm legal tax rules, rounding and registration details with a qualified accountant before issuing invoices.

Example fictional preview input (never commit real customer information):

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

Preview response is `PREVIEW_ONLY`, `persisted: false`; saved draft response is `DRAFT`, `persisted: true`, with a database UUID and creation timestamp. Both explicitly indicate `waveSynced: false` and `emailed: false`. No official invoice number is generated.

## Dedicated database: opt-in only

1. Create a **new database exclusively for Facturations**. Never reuse TAKATAK's existing production database or Supabase project without a separate, explicitly authorized isolated environment.
2. Review `db/001_draft_storage.sql`, then apply it **only to the new Facturations database** using your approved database administration tool. This migration creates `invoice_customers`, `invoice_drafts`, and append-only `invoice_audit_events` for `DRAFT_CREATED`.
3. Configure `FACTURATIONS_DATABASE_URL` and `WAVE_BUSINESS_ID` **together** in private server environment variables. Obtain the exact Wave business ID through the authenticated read-only `/api/wave/businesses` route; do not guess it.
4. Restart **only** the separate Facturations app. Until both values are present, draft save/read endpoints return `STORAGE_NOT_CONFIGURED` (HTTP 503); previews and read-only Wave lookup remain available.
5. Use a database credential restricted to only the new Facturations database, with TLS configured according to your database provider. Arrange encrypted backups, retention, access logging, restore testing, database roles and deletion policies before storing real customer information.

Each saved draft is scoped to a server-configured business ID, uses a unique request key and a SHA-256 hash of the server-calculated preview, and creates a `DRAFT_CREATED` audit event in the same transaction. Retries do not create duplicate drafts/audit events. These controls do not replace full per-user identity, authorization and row-level security for a future client portal.

GitHub Actions runs simulated unit/API tests and **real disposable PostgreSQL 16 integration tests** on Node 20/22. The test setup script refuses database addresses other than `localhost/facturations_test`. Neither test environment nor GitHub uses production credentials.

## MochaHost and future milestones

Wait for MochaHost to confirm independent DNS/SSL and Node.js support for `facturations.bolon.ca`. Deploy **only this repository** to a new application root, install dependencies and configure the environment privately. Do not touch any existing TAKATAK website, application, database or repository.

See `docs/product-blueprint.md` for the planned secure customer portal, TAKATAK identity integration, Wave issuance with explicit human confirmation, email delivery, PDFs, payments and intelligent assistant workflow. These are **design plans, not deployed features**.
