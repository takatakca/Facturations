# Immutable draft and audit history (Phase 3 hardening)

**Not deployed.** This change protects the *new dedicated Facturations PostgreSQL database* only; do not run these migrations against any existing GROUPE TAKATAK production database.

Apply `db/001_draft_storage.sql` then `db/002_immutable_drafts_audit.sql` in numerical order using a separately authorized migration account. The test setup applies both only when `FACTURATIONS_TEST_DATABASE_URL` resolves to `localhost` or `127.0.0.1`, database path `/facturations_test`. Neither GitHub Actions nor the test script uses live credentials.

The second migration adds database triggers that reject updates/deletions of `invoice_audit_events`, reject deletes of `invoice_drafts`, and reject edits to an existing draft's identity, request hash, idempotency key, creation date or JSON snapshot. Future draft corrections must create a new version/revision with an audit event rather than silently changing the original. Non-financial `updated_at` bookkeeping remains allowed. Existing create/read behavior is unchanged.

**Boundary:** Triggers are defense in depth, not cryptographic tamper-proofing: a table owner or PostgreSQL superuser can disable them, and an overprivileged role could insert misleading records. Provision a distinct least-privilege runtime role that cannot alter schemas or triggers; restrict direct database access, log administrative migrations, arrange encrypted backups and prove restore procedures before real client data. These triggers do **not** provide staff authentication, row-level security, human invoice approval, Wave issuance, PDF or emails.
