# Production readiness hardening

This layer converts several staging assumptions into explicit runtime gates.

## Production startup gate

When `NODE_ENV=production`, startup now fails closed unless all of the following are present:

- a non-zero `PORT`;
- the dedicated `FACTURATIONS_DATABASE_URL`;
- `WAVE_BUSINESS_ID`;
- exact HTTPS `FACTURATIONS_PUBLIC_ORIGIN`;
- a 32-byte hex `FACTURATIONS_TOTP_ENCRYPTION_KEY`.

Loopback browser origins are rejected in production.

This does not prove that DNS, TLS, the reverse proxy, database permissions or backups are correct. Those are verified separately.

## Liveness vs readiness

`GET /health` remains a process liveness check. It intentionally does not query PostgreSQL.

`GET /ready` is the deployment/readiness check:

- 200 only when the dedicated PostgreSQL pool answers `SELECT 1`;
- 503 when no readiness probe is configured;
- 503 on PostgreSQL failure;
- 503 as soon as graceful shutdown begins;
- no database error, hostname, credential or SQL detail is returned.

The staging HTTPS preflight now requires both `/health` and `/ready`.

## Graceful shutdown

SIGTERM and SIGINT:

1. mark readiness as draining;
2. stop accepting new HTTP work;
3. close idle connections;
4. wait for the HTTP server to close;
5. close the PostgreSQL pool.

A bounded timeout marks shutdown as failed and force-closes remaining connections.

This reduces avoidable partial requests during deploy/restart, but does not replace idempotence and reconciliation for external operations.

## Remaining external gates

This hardening does not authorize production. The following still require external evidence:

- protected `main` with required CI and independent review;
- isolated HTTPS staging;
- least-privilege production database user;
- encrypted backup and demonstrated restore;
- real legal/fiscal issuer validation;
- authorized Wave write/reconciliation tests;
- homologated email provider and signed webhooks;
- homologated payment processor if payments are enabled;
- monitoring/alert routing and operational ownership.
