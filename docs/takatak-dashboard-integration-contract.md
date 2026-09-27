# TAKATAK Dashboard ↔ Facturations — integration contract v1

Status: implementation contract for the upcoming TAKATAK dashboard integration. This document does not authorize production deployment or real financial side effects.

## Product boundary

Facturations remains an independent application and deployable service. The TAKATAK dashboard may expose Facturations as a native module, but it must not copy the Facturations database, bypass Facturations authorization, or depend on private implementation details.

The integration is API-first:

```
TAKATAK Dashboard
  -> authenticated integration gateway
     -> Facturations service
        -> dedicated Facturations PostgreSQL
        -> provider adapters (Wave/email/payment/OpenAI), each separately gated
```

The same Facturations service must remain usable later by other approved products or standalone customers.

## Non-negotiable rules

- No shared browser admin key.
- No direct browser connection to the Facturations database.
- No direct TAKATAK write to Facturations PostgreSQL tables.
- No cross-tenant lookup by email/name alone.
- Every request is scoped by a verified `business_id` and authenticated principal.
- Existing Facturations OWNER/STAFF/CLIENT authorization remains authoritative inside Facturations.
- Issuance, delivery, publication, payment and MFA recovery keep their existing explicit gates.
- Integration failures must fail closed.
- No secret, customer data, invoice body, token, raw provider response or API key in URL/query strings or logs.

## Integration identity

The long-term contract is short-lived signed service-to-service identity, not `TAKATAK_ADMIN_KEY`.

Required claims for an authenticated TAKATAK request:

- `iss`: approved TAKATAK identity issuer;
- `aud`: exact Facturations audience;
- `sub`: stable TAKATAK master identity ID;
- `business_id`: stable business/tenant identifier;
- `roles`: bounded set mapped to Facturations permissions;
- `iat`, `exp`, `jti`: issued time, short expiry and replay identifier.

Facturations must verify signature, issuer, audience, expiry and business mapping server-side before any data access. The dashboard must never be able to self-assert OWNER.

Until this signed integration is implemented and reviewed, the existing standalone Facturations staff login remains the supported authentication path.

## Versioned integration namespace

Reserve the namespace:

`/integration/v1/*`

Do not overload the existing browser `/internal/*` routes or private administrative `/api/*` routes.

### Planned read-only endpoints

- `GET /integration/v1/capabilities`
  - feature flags and supported flows only;
  - no customer/invoice data;
  - useful for TAKATAK to decide which UI modules to render.

- `GET /integration/v1/dashboard`
  - tenant-scoped summary;
  - draft counts/amounts explicitly marked draft-only;
  - issued/payment values only when backed by verified Facturations read models.

- `GET /integration/v1/drafts`
  - paginated scoped draft summaries.

- `GET /integration/v1/drafts/:id`
  - scoped draft detail subject to role authorization.

- `GET /integration/v1/customers`
  - OWNER or specifically granted accounting role only.

### Planned write endpoints

Writes are not enabled merely because the namespace exists. Each write remains mapped to a deterministic Facturations operation and its existing authorization gate.

Examples:

- create draft;
- revise draft with revision token;
- submit draft for review;
- OWNER approval;
- OWNER issuance authorization;
- OWNER delivery authorization;
- OWNER portal publication.

No integration endpoint may combine multiple irreversible actions into one call.

## Response envelope

Successful integration responses should use a versioned envelope:

```json
{
  "version": 1,
  "requestId": "server-generated-id",
  "businessId": "verified-business-id",
  "data": {}
}
```

Errors use stable machine-readable codes without raw internals:

```json
{
  "version": 1,
  "requestId": "server-generated-id",
  "error": {
    "code": "OWNER_REQUIRED"
  }
}
```

The dashboard must display user-facing copy from its own FR/EN presentation layer rather than exposing raw internal errors.

## Concurrency and idempotency

All state-changing integration calls require:

- explicit idempotency key where applicable;
- current revision/version for mutable drafts;
- 409 on stale revision or conflicting state;
- no automatic retry of ambiguous provider side effects;
- immutable audit event after accepted state transitions.

## UI integration strategy

TAKATAK may render a native Facturations module at a route such as:

`/dashboard/facturations`

The UI may share TAKATAK navigation, branding and master identity, while Facturations remains the source of truth for invoice workflow authorization and finance-specific state.

Recommended first integration:

1. capability discovery;
2. read-only dashboard summary;
3. open standalone Facturations workspace via trusted identity handoff;
4. only then add native draft/customer screens through the versioned integration API.

This avoids duplicating complex invoice logic inside the TAKATAK dashboard during the first integration.

## Security test matrix before activation

- expired token;
- wrong issuer;
- wrong audience;
- forged role;
- wrong `business_id`;
- replayed `jti`;
- missing tenant mapping;
- CLIENT attempting staff endpoint;
- STAFF attempting OWNER endpoint;
- cross-business UUID access;
- stale revision;
- CSRF not relied upon for server-to-server bearer authentication;
- no secret/token/PII in logs.

## Deployment boundary

The TAKATAK integration can be developed before MochaHost staging, but it is not production-enabled until Facturations has its isolated HTTPS deployment, private Node port, dedicated PostgreSQL, runtime least-privilege role, backup/restore proof and staging security evidence.

