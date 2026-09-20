# Staff read-only API boundary (development, NOT production login)

The backend can now resolve a previously issued staff session token for **read-only** operations in the one business configured by `WAVE_BUSINESS_ID` and the dedicated database. This is an internal server-side authorization building block, not a public sign-in, browser dashboard, or customer portal.

## Auth behavior

- With `Authorization: Bearer <43-character-session-token>`, `GET /api/dashboard/summary`, `GET /api/drafts` and `GET /api/drafts/:uuid` require a valid unexpired and unrevoked staff session, verified/enabled staff identity, an `OWNER` or `STAFF` role, and an exact match to the configured business ID. The staff store enforces its business scope in PostgreSQL; the server checks it again.
- A staff bearer token **cannot** call Wave, preview/save draft writes or future invoice issuance. An invalid bearer token does not fall back to a simultaneous `X-Admin-Key` header. Session resolution/database failures return a generic 503 without disclosing credentials or customer data.
- Legacy `X-Admin-Key` requests remain solely for private server-to-server development and must never be embedded in browser JavaScript, mobile apps, screenshots or URLs. This is not an acceptable long-term authentication mechanism for a customer-facing service.
- `/health` remains public and non-sensitive. Unknown routes (including login, activation, email, PDF and customer portal) remain unimplemented and return 404.

## Explicitly missing before browser exposure

Trusted owner bootstrap; audited invitation delivery to the correct mailbox; browser authentication with HttpOnly/Secure/SameSite cookies, session rotation and CSRF protections; MFA for owner; distributed IP/account rate limiting; staff permissions and approval audit; password recovery; monitoring, dedicated least-privilege DB roles, backups and staging review. Do not put a staff session token into frontend source, localStorage or URLs. Do not deploy this as a finished login system.

Use only the synthetic tests and separate PostgreSQL test database until the above safeguards are implemented. Never reuse a TAKATAK production database or expose real customer information in the public repository.
