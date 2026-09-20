# Authenticated workspace HTTP boundary — not yet an editor

`src/browser-workspace-routes.js` adds a cookie-authenticated, development-only JSON boundary to the revisioned workspaces from migration 008. It is installed **only** when the dedicated database, exact HTTPS `FACTURATIONS_PUBLIC_ORIGIN` and MFA encryption key are configured. The app must be reachable exclusively through the trusted HTTPS reverse proxy; the code does not prove transport security or provision staff accounts. Do not deploy to an existing GROUPE TAKATAK production database.

## Routes and security

- `GET /internal/workspaces/csrf` returns a session-bound anti-CSRF token **only** to a current enabled, verified OWNER/STAFF session identified by the `__Host-facturations-session` cookie.
- `POST /internal/workspaces` accepts exactly `{ "creationKey": "...", "content": { ... } }` as JSON, with the matching `X-Facturations-CSRF` header and exact configured HTTPS `Origin`/`Host`. It creates a private staff-owned workspace or returns the idempotent result; it does **not** create an invoice.
- `GET /internal/workspaces/<uuid>` loads a workspace for its original employee only, within the configured business. Do not put customer data, session tokens or CSRF tokens in a URL.
- `PUT /internal/workspaces/<uuid>` accepts exactly `{ "expectedRevision": 1, "content": { ... } }` with the same origin/CSRF checks, returning 409 when the revision is stale. The browser must retain its unsaved edits for explicit conflict resolution.

These routes refuse bearer authorization and `X-Admin-Key`, reject query parameters and unrecognized methods, cap the JSON request to 32 KiB, use no-store and same-origin response restrictions, and return only generic errors on unexpected failures. CSRF tokens are derived with a separated key from the private MFA encryption key and bound to the staff session token; they are **not** an alternative credential and must never be persisted in browser localStorage, URLs, logs or telemetry. The backend store rechecks live tenant-scoped sessions in the same PostgreSQL transaction for each create/load/save. The old admin-only invoice endpoints are unaffected; browser cookies grant no permission to issue, approve, send or contact Wave.

## Not delivered yet

No mobile FR/EN draft editor, client search, autosave timer, offline queue, conflict-resolution interface, accessible first-run tour, actual recovery workflow, user provisioning, independent production security audit or validated staging deployment is provided by these routes. The client must fetch a CSRF token in memory after authenticating, show **Saved** only after a successful server response, preserve edits on errors, and never silently overwrite another revision. Validate complete browser E2E behavior with a dedicated PostgreSQL database and the configured TLS proxy before any real customer data is used. See audit issue #27 and `docs/first-run-guidance.md`.