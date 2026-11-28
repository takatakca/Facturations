# Coolify staging deployment (Contabo VPS)

Status: **deployment kit**. It does not authorize real invoices, Wave writes, real email, payments or client-portal exposure. Those keep their own OWNER gates and the GO/NO-GO dossier (`docs/staging-go-no-go.md`).

Facturations runs as its **own Coolify application** with its **own PostgreSQL**. It never shares a database with TAKATAK.

```
Internet ──HTTPS──▶ Coolify proxy (Traefik, TLS) ──▶ Facturations container :3000
                                                        │  runtime role (least privilege)
                                                        ▼
                                              Coolify PostgreSQL (dedicated)
TAKATAK server ──HTTPS + signed 60 s token──▶ /integration/v1/*  (drafts only)
```

## 1. Database (Coolify → + New → Database → PostgreSQL 16)

- Name it `facturations-db`. Do **not** reuse a TAKATAK database.
- Initial database name: `facturations`.
- Enable SSL in the database settings, then start it.
- Copy the **internal** connection URL. This is the owner/migrator identity.

## 2. Application (Coolify → + New → Application → GitHub → `takatakca/Facturations`)

- Branch: `main`. Merge the deployment PRs first.
- Build pack: **Dockerfile** (repository root). Exposed port: `3000`.
- Domain: `https://<facturations-staging-host>`. Coolify issues the certificate.
- Health check: the image already declares one (`scripts/container-healthcheck.js`, which requires `/ready`).

### Environment variables (Coolify → application → Environment Variables)

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `FACTURATIONS_TRUST_PROXY` | `1` |
| `FACTURATIONS_PUBLIC_ORIGIN` | `https://<facturations-staging-host>` (exact, no trailing slash) |
| `WAVE_BUSINESS_ID` | the GROUPE TAKATAK business id (also used by TAKATAK as `FACTURATIONS_BUSINESS_ID`) |
| `FACTURATIONS_TOTP_ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex characters) |
| `FACTURATIONS_MIGRATION_DATABASE_URL` | internal URL from step 1 + `?sslmode=no-verify` |
| `FACTURATIONS_RUNTIME_DB_ROLE` | `facturations_app` |
| `FACTURATIONS_RUNTIME_DB_PASSWORD` | `openssl rand -base64 36` (at least 24 characters) |
| `FACTURATIONS_DATABASE_URL` | same host/db as step 1, user `facturations_app`, the password above, `?sslmode=no-verify` |
| `FACTURATIONS_INTEGRATION_ENABLED` | `1` |
| `FACTURATIONS_INTEGRATION_WRITES_ENABLED` | `1` only once TAKATAK draft creation should work, otherwise empty |
| `FACTURATIONS_INTEGRATION_ISSUER` | e.g. `takatak-v1-staging`, the same value on TAKATAK |
| `FACTURATIONS_INTEGRATION_AUDIENCE` | e.g. `facturations-staging`, the same value on TAKATAK |
| `FACTURATIONS_INTEGRATION_HMAC_SECRET` | `openssl rand -base64 48`, the same value on TAKATAK only |

Mark every secret as a secret in Coolify. Never commit or paste these values anywhere else.

`sslmode=no-verify` encrypts traffic on Coolify's private Docker network without validating Coolify's self-signed database certificate.

## 3. First deployment: one-time console steps

Coolify → application → **Terminal**:

```bash
npm run ops:prepare-db -- --confirm=APPLY_FACTURATIONS_MIGRATIONS
npm run check:runtime-db
npm run ops:bootstrap-owner -- --email=<owner email> --verified-by="owner present at console <date>" --confirm=BOOTSTRAP_FIRST_OWNER
```

What each command does:

- **`ops:prepare-db`**
  - Verifies the migration lock.
  - Refuses any database that already contains a foreign schema (for example TAKATAK) or untracked tables.
  - Applies migrations 001–045 exactly once.
  - Creates `facturations_app` and applies `ops/runtime-db-grants.sql`.
  - Re-running it is safe: it applies only what is pending.
- **`check:runtime-db`** proves the app's role is least-privileged and uses an encrypted connection.
- **`ops:bootstrap-owner`**
  - Works only while the business has **no** staff account.
  - Prints a generated password and an authenticator key **once**.
  - Asks for a 6-digit code to activate two-factor authentication.
  - Lost the key before activating? Run `npm run ops:bootstrap-owner -- --email=<owner email> --rotate-pending-secret`.

Then restart the application once. Sign in at `https://<host>/internal/login?lang=fr` with email, password and authenticator code.

After the first deployment, you may remove `FACTURATIONS_MIGRATION_DATABASE_URL` and `FACTURATIONS_RUNTIME_DB_PASSWORD` from the application environment. Add them back only to run future migrations.

## 4. Verify

- `https://<host>/health` returns 200 and `https://<host>/ready` returns 200.
- The direct container port is not published. Only the Coolify proxy reaches it.
- `node scripts/staging-readonly-preflight.js` passes against the staging host.
- Login with a wrong code fails, and the right code opens the dashboard.

## 5. Connect TAKATAK (server environment only)

```
FACTURATIONS_INTEGRATION_ENABLED=1
FACTURATIONS_ORIGIN=https://<facturations-staging-host>
FACTURATIONS_INTEGRATION_HMAC_SECRET=<same secret>
FACTURATIONS_INTEGRATION_ISSUER=<same issuer>
FACTURATIONS_INTEGRATION_AUDIENCE=<same audience>
FACTURATIONS_BUSINESS_ID=<WAVE_BUSINESS_ID>
```

TAKATAK **Admin → Billing • Facturations** then shows "Configured". Drafts it creates appear in Facturations under **Brouillons à examiner** (`/internal/review`).

## Rehearsal evidence (local, synthetic data)

The full flow was rehearsed:

1. Fresh PostgreSQL, then `ops:prepare-db` (45/45; the rerun applied 0; a TAKATAK-like database was refused).
2. `check:runtime-db` PASS.
3. Production mode behind a TLS proxy that sets `X-Forwarded-Proto`.
4. Container health check PASS; a direct un-proxied request returned 421.
5. `ops:bootstrap-owner` with TOTP activation; a second bootstrap was refused.
6. TAKATAK created a draft over HTTPS. The TAKATAK total matched the Facturations total.
7. Real Chromium form login with password and TOTP reached the dashboard, and the TAKATAK draft was listed under *Brouillons à examiner*.

The rehearsal also found the real-browser login defect fixed in the separate PR `fix/browser-form-origin-referrer-policy`.
