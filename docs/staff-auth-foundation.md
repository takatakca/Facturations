# GROUPE TAKATAK — staff authentication foundation (NOT enabled for users)

This module is **internal application code**, not a working staff login page, invitation system or client portal. It is intentionally **not attached to any HTTP endpoint**. `X-Admin-Key` remains a temporary server-to-server development header; do not place it in browser code or expose the draft/dashboard API publicly.

## Included in this increment

- `db/003_staff_identity_sessions.sql` creates **new, separately scoped** staff users and revocable sessions. Apply **after** migrations 001 and 002 to a NEW Facturations-only database, never a TAKATAK production database.
- `src/staff-auth-store.js` offers `createPendingStaff`, `authenticate`, `getSession` and `revokeSession` to trusted server code. Passwords are derived with asynchronous Node.js scrypt and per-user random salts; raw session tokens are random 256-bit values and **only SHA-256 digests are persisted**. Session validity requires the matching business ID, verified email, enabled user, an unrevoked token and an unexpired 12-hour session.
- Pending staff accounts start **unverified** and cannot authenticate. Five incorrect password attempts cause a 15-minute account lock. Unknown usernames and incorrect passwords return the same generic error. Database lookups and revocation are business-scoped. Tokens and passwords must never appear in logs, GitHub, email, URLs or screenshots.
- GitHub Actions uses **fictional** identities and a disposable localhost PostgreSQL 16 instance for negative integration tests; test code simulates email verification directly in the isolated test database. This is not a production verification mechanism.

## Deliberately NOT implemented / prerequisites

1. Trusted first-owner bootstrap and invitation delivery with hashed, expiring single-use tokens; real email ownership verification and audited role assignment. **Do not manually mark real addresses verified without an approved identity-verification process.**
2. Browser-safe session handling (Secure, HttpOnly, SameSite cookies), CSRF tokens/origin checks, distributed per-IP and per-account rate limiting, security logging, reset/recovery, MFA for privileged staff and trusted reverse-proxy configuration.
3. Connect authenticated users to every API request with explicit per-business/per-role authorization. Remove the temporary administrator header before public dashboard/portal use. Staff permission design and customer identity remain separate.
4. Secure production provisioning, least-privilege PostgreSQL roles, TLS, backups and restore drill. Current database schema and tests do not prove end-to-end login or deployment.

The standalone module **must not be wired to a public HTTP route yet**. No changes were made to MochaHost, live Wave, existing TAKATAK sites, or real customer data.
