# Draft dashboard API — backend foundation only

This is a **server-side read-only API**, not a browser dashboard or client portal. Do not expose `TAKATAK_ADMIN_KEY` in any browser, mobile app or customer account. Build staff authentication, sessions and per-business authorization (issue #3) before connecting a UI.

## Routes (all require `X-Admin-Key` on a trusted server-side request)

- `GET /api/dashboard/summary`: returns `{ status: "DRAFTS_ONLY", currency: "CAD", draftCount: "2", draftTotalCents: "5000", customerCount: "2", issuedInvoicesAvailable: false, paymentsAvailable: false, revenueAvailable: false }`. Counts and totals are **decimal strings** to avoid JavaScript integer overflow. `draftTotalCents` is the sum of *unissued draft estimates*, **NOT** billed revenue, accounts receivable or paid sales.
- `GET /api/drafts?page=1&pageSize=20`: returns `{ status: "DRAFTS_ONLY", page: 1, pageSize: 20, drafts: [...] }`. Maximum `page=1000` and `pageSize=50`; pages start at 1. Rows include draft ID, customer display name, invoice/due dates, total in integer cents as a string and created time, but do **not** include email or address. Ordering: newest first, with UUID tie-breaker. Offset pagination may shift if drafts arrive during browsing; use cursor pagination before large-scale production.

Both routes fail closed with `STORAGE_NOT_CONFIGURED` if the separate database or business mapping is missing. They make **no Wave write calls**, create **no invoices**, and send **no emails**. They must never be interpreted as confirmation of a live Wave connection, an operational dashboard or a deployed site.

The new database should be dedicated exclusively to `facturations.bolon.ca`. CI runs integration tests only on a disposable `localhost/facturations_test` PostgreSQL instance. Never point those tests at existing GROUPE TAKATAK systems.

## Production readiness prerequisites

1. Complete issue #3: real staff identity and tenant-specific role checks; retire the shared admin header for UI traffic.
2. Complete issue #4: approved, reconciled Wave issuance before showing issued-invoice or receivables totals.
3. Complete issue #7: verified payments and refunds before showing financial revenue or paid metrics.
4. Add the actual branded responsive FR/EN dashboard with keyboard accessibility and automated end-to-end tests.
5. Complete MochaHost's independent DNS, SSL, Node.js and database setup, backup/restore and security sign-off.
