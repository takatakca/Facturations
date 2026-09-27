# TAKATAK Dashboard → Facturations integration handoff v1

This is the implementation handoff for the native TAKATAK dashboard integration. It describes the code currently staged through the integration PR chain. It does **not** authorize production traffic or real financial side effects.

## Architecture

The browser never calls Facturations with a service secret.

```
TAKATAK browser
  -> TAKATAK server / route handler
     -> short-lived signed service token
        -> Facturations /integration/v1/*
           -> tenant-scoped Facturations stores
```

Keep Facturations independently deployable. Do not connect the TAKATAK browser directly to the Facturations database and do not copy `TAKATAK_ADMIN_KEY` into the browser.

## Current v1 endpoints

### GET /integration/v1/capabilities

Purpose: feature discovery.

OWNER example capabilities:

```json
{
  "version": 1,
  "requestId": "<server-generated-uuid>",
  "businessId": "<verified-business-id>",
  "data": {
    "service": "facturations",
    "integrationVersion": 1,
    "capabilities": {
      "capabilitiesRead": true,
      "dashboardRead": true,
      "draftsRead": true,
      "customersRead": true,
      "draftWrite": false,
      "ownerApprovalWrite": false,
      "issuanceAuthorizationWrite": false,
      "deliveryAuthorizationWrite": false,
      "portalPublicationWrite": false
    },
    "standalone": {
      "staffWorkspace": true,
      "clientPortal": true,
      "bilingual": ["fr", "en"]
    }
  }
}
```

For STAFF, `customersRead` is false.

### GET /integration/v1/dashboard

Returns draft-only summary metrics. Do not label these values as revenue, receivables or collected payments.

```json
{
  "version": 1,
  "requestId": "<server-generated-uuid>",
  "businessId": "<verified-business-id>",
  "data": {
    "status": "DRAFTS_ONLY",
    "currency": "CAD",
    "draftCount": "3",
    "draftTotalCents": "125050",
    "customerCount": "2",
    "issuedInvoicesAvailable": false,
    "paymentsAvailable": false,
    "revenueAvailable": false
  }
}
```

### GET /integration/v1/drafts?page=1&pageSize=20

Maximum page size is 50. The response deliberately contains only summary data.

```json
{
  "version": 1,
  "requestId": "<server-generated-uuid>",
  "businessId": "<verified-business-id>",
  "data": {
    "status": "DRAFTS_ONLY",
    "page": 1,
    "pageSize": 20,
    "drafts": [
      {
        "id": "<draft-uuid>",
        "customerName": "Example Customer",
        "invoiceDate": "2026-09-27",
        "dueDate": "2026-10-12",
        "totalCents": "85000",
        "currency": "CAD",
        "status": "DRAFT"
      }
    ]
  }
}
```

### GET /integration/v1/customers?page=1&pageSize=20&q=Example

OWNER only. Minimum search text is 2 characters and maximum is 80. Response fields are minimized:

```json
{
  "version": 1,
  "requestId": "<server-generated-uuid>",
  "businessId": "<verified-business-id>",
  "data": {
    "status": "CUSTOMERS_ONLY",
    "page": 1,
    "pageSize": 20,
    "hasMore": false,
    "customers": [
      {
        "id": "<customer-uuid>",
        "name": "Example Customer",
        "email": "customer@example.test"
      }
    ]
  }
}
```

Address and internal directory metadata are not exposed through this endpoint.

## Current service-token format

Current v1 verification is server-to-server HS256. The shared HMAC secret must exist only in the two trusted server environments.

Header:

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

Exact payload claims:

```json
{
  "version": 1,
  "iss": "<configured-takatak-issuer>",
  "aud": "<configured-facturations-audience>",
  "sub": "<stable-takatak-master-identity-id>",
  "business_id": "<mapped-facturations-business-id>",
  "roles": ["OWNER"],
  "iat": 0,
  "exp": 0,
  "jti": "<unique-16-to-128-char-request-token-id>"
}
```

Rules:

- token lifetime must be at most 90 seconds;
- `iat` and `exp` are integer epoch seconds;
- `iss`, `aud` and `business_id` must exactly match Facturations configuration;
- accepted roles are currently `OWNER` and `STAFF`;
- never derive OWNER from a browser field;
- do not put the token in a query string, URL, browser storage or logs;
- generate a fresh `jti` for each token.

## Minimal Node.js signer example for the TAKATAK server

This code belongs on the TAKATAK server only. The secret must come from server-side environment configuration.

```js
const crypto = require('node:crypto');

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createFacturationsToken({
  secret,
  issuer,
  audience,
  subject,
  businessId,
  roles
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    version: 1,
    iss: issuer,
    aud: audience,
    sub: subject,
    business_id: businessId,
    roles,
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID()
  };

  const signingInput =
    base64urlJson(header) + '.' + base64urlJson(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  return signingInput + '.' + signature;
}
```

## Recommended first TAKATAK server route

The TAKATAK browser calls its own backend. The backend signs the service token and proxies only the bounded Facturations response.

Example flow:

```
GET /api/facturations/dashboard
  1. authenticate TAKATAK user
  2. resolve MasterIdentity
  3. resolve allowed business membership
  4. map TAKATAK role -> OWNER or STAFF
  5. create 60-second Facturations service token
  6. server fetch GET <FACTURATIONS_ORIGIN>/integration/v1/dashboard
  7. return the bounded JSON to the TAKATAK browser
```

Do not accept `business_id`, role, issuer or audience from browser JSON/query input.

## Error handling

Treat these as expected fail-closed outcomes:

- `401 INTEGRATION_AUTH_REQUIRED`
- `401 INVALID_INTEGRATION_TOKEN`
- `401 INVALID_INTEGRATION_CLAIMS`
- `401 EXPIRED_OR_INVALID_INTEGRATION_TOKEN`
- `403 OWNER_REQUIRED`
- `404 NOT_FOUND` when integration is disabled
- `422 INVALID_QUERY`, `INVALID_PAGE`, `INVALID_PAGE_SIZE`, or customer-search validation errors
- `503 STORAGE_NOT_CONFIGURED` / `STORAGE_UNAVAILABLE`

Never show raw server/provider errors to the end user.

## What TAKATAK may build now

The dashboard team can safely build against mock responses matching this contract:

1. Facturations navigation item.
2. Draft-only summary cards.
3. Paginated draft list.
4. OWNER-only customer directory.
5. Loading, empty, forbidden and unavailable states.
6. A link/handoff to the standalone Facturations workspace.

Do **not** build native invoice issuance/send/payment buttons yet because those integration capabilities intentionally remain false.

## Activation gate

Real calls wait for isolated Facturations staging with:

- HTTPS;
- private Node port behind trusted proxy;
- dedicated PostgreSQL;
- least-privilege runtime DB role;
- backup/restore proof;
- integration secret configured outside GitHub;
- exact issuer/audience/business mapping;
- staging negative-path tests.

