# Internal draft approval — backend-only foundation

This increment introduces `db/005_internal_draft_approvals.sql` and `src/draft-approval-store.js` for a durable, append-only owner decision on the **exact immutable draft snapshot**. There is intentionally **no public HTTP route**, browser button, AI tool, mailer, Wave write, payment action, or deployment in this change.

## Trusted invocation contract

`createDraftApprovalStore({pool, businessId}).approveDraft({confirmation:'APPROVE_DRAFT_ONLY',draftId,ownerId,sessionToken,expectedTotalCents,expectedCustomerEmail})` is for a future authenticated backend handler after owner bootstrap, MFA, CSRF protection, rate controls and a reviewed UI are implemented. Never place session tokens or administrative keys into URLs, client bundles, logs or public GitHub files.

The service verifies a non-revoked, unexpired, email-verified OWNER session in the same business; locks session and owner rows; verifies that the draft exists within that business; compares the exact customer email and total in cents against the stored snapshot; and inserts a single immutable approval tied to the draft's stored request hash. An identical concurrent retry by the same owner returns the first decision without duplicate records. A second owner's competing decision is rejected. The draft itself stays `DRAFT`; an internal approval is **not** an issued invoice and must never be shown as revenue or as a Wave-synced or emailed item.

## Verified by isolated CI

The PostgreSQL integration test uses synthetic `example.test` data and a disposable local `facturations_test` database. It tests missing explicit confirmation, malformed inputs, stale total/recipient, STAFF and foreign-business rejection, missing drafts, invalid/revoked sessions, concurrent identical attempts, and rejection of direct approval modification/deletion. The migration script refuses any database other than localhost/127.0.0.1 `facturations_test`.

## Still required before any real operation

Owner provisioning and audited invitation delivery, MFA, secure browser login and CSRF, rate limiting, revision/approval UI, separate explicit invoice issuance approval and separate delivery confirmation, Wave API verification/idempotent issuance/reconciliation, branded PDFs, approved email, customer portal and permission tests, proper least-privilege DB role, MochaHost isolated staging, backup/restore, and end-to-end sign-off. Nothing in this implementation authorizes actual invoice issuance or customer communication.
