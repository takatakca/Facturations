# Staff read-only API boundary (development, NOT production login)

The backend resolves a previously issued staff session token for read-only operations in the business configured by `WAVE_BUSINESS_ID` and the dedicated database. This is an internal authorization building block, NOT a public login, browser dashboard or customer portal.

## Auth behavior

- With `Authorization: Bearer <43-character-session-token>`, `GET /api/dashboard/summary` and `GET /api/drafts` allow a valid, verified, enabled, unexpired OWNER or STAFF account for the configured business. The listing contains minimal draft summaries and does not include customer emails, addresses or the full invoice snapshot.
- `GET /api/drafts/:uuid` returns the full immutable preview, including the recipient email, street address and free-form notes. It therefore **requires OWNER**; STAFF receives `403 OWNER_REQUIRED` before accessing the draft store.
- `GET /api/customers` also requires OWNER. Invalid/cross-business/revoked tokens cannot fall back to a simultaneous `X-Admin-Key`; this header is for private server-to-server development only and must never enter browsers.
- Staff bearer tokens cannot call Wave, preview/save draft writes or issue invoices. Session storage failure returns generic `503 AUTH_UNAVAILABLE`, without SQL or secrets.
- `/health` is public. Login, activation, email, PDF and customer portal routes are not yet implemented.

## Missing before browser exposure

Trusted owner bootstrap; audited invitation delivery; MFA for privileged owner accounts; secure browser cookies with session rotation and CSRF defenses; distributed IP/account rate limiting; recovery, monitoring, least-privilege database roles, backup/restore and isolated staging review. No session tokens in frontend source, URLs or localStorage. A future fine-grained staff permission model may permit specific invoice details only after deliberate authorization and masking of private fields.

Use synthetic tests and the separate PostgreSQL test database until these safeguards are in place. Never reuse TAKATAK production databases or put real customer information in the public repository.
