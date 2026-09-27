# Browser work-in-progress editor — bounded first increment

This is a **private preparation workspace**, NOT an issued invoice or complete invoice editor. It mounts only when the independent Facturations service has the dedicated database, an exact HTTPS `FACTURATIONS_PUBLIC_ORIGIN`, and its MFA encryption key configured. It cannot establish TLS itself: the app must be reachable exclusively through a verified, trusted HTTPS proxy. Never deploy on the existing TAKATAK production application or use real clients until audit #27 and issue #41 release gates pass.

## How to reach it

After verified staff login, navigate on the isolated staging origin to `/internal/editor?lang=fr` or `/internal/editor?lang=en`. The page and its same-origin external JavaScript require a valid, enabled, verified OWNER/STAFF session cookie, and reject Bearer and `X-Admin-Key`. The page never embeds a session credential or CSRF token. CSP permits only the same-origin script and same-origin network requests, and responses use `private, no-store`.

The first screen edits **customer name and working notes only**. It deliberately does not calculate totals, allow editing line items/taxes, produce an official invoice, approve, emit, email or collect a payment. It uses the existing server-side workspace JSON API and PostgreSQL migration 008. A random in-memory creation key enables idempotent retry in the same page. After a confirmed first save, the workspace UUID (a locator, not an authorization token) enters the page URL so refreshing can reload the server record. No customer data, session key or CSRF token is placed in the URL or browser storage.

Each manual save fetches a session-bound CSRF token in memory, sends the exact configured same-origin JSON request, and displays **Saved** only after receiving a valid server confirmation. Later saves include `expectedRevision`. On HTTP 409 conflict, the editor retains the entered text and requires an explicit choice before reloading; it does not automatically overwrite a concurrent revision. Existing customer email/address, line items, taxes and other undisplayed properties are preserved in the request. If a workspace contains incompatible customer/notes shapes or an issued status, editing is blocked. Leaving the page with unsaved changes triggers the browser's best-effort native warning.

## Remaining work and staging acceptance

- Integrate a full multi-item invoice editor, validated customer selection, explicitly configured tax rates, server-calculated preview, and a separate owner approval interface. This initial view does **not** produce a complete valid invoice.
- Test actual browser FR/EN/mobile behavior, keyboard/screen-reader accessibility, native navigation warnings, lost network responses, CSRF rejection, expired sessions, two tabs editing the same workspace, revoked staff and cross-business access on **isolated HTTPS staging with disposable records**. Node sandbox tests are not a substitute for browser E2E.
- Provide a durable creation-key recovery workflow for browser closure during an ambiguous first save, plus workspace listing/navigation and a formal conflict resolution UX. A retry within the open page reuses the same key, but closing the tab before receiving its first confirmed UUID may lose the locator.
- Finish verified account enrollment/recovery, database least privilege and backups/restoration, branch protection and independent review before any real data or external invoice operation. Wave remains read-only.
