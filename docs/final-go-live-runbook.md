# Facturations — final GO-LIVE runbook

This runbook is the release boundary for the current Facturations codebase. Completing the code does **not** by itself authorize production; every GO item below needs evidence.

## 1. Git / release control

GO only if:

- `main` is protected;
- direct push and force-push are blocked;
- required CI checks are enforced;
- at least one independent review is required;
- unresolved conversations block merge;
- the exact release SHA has green Node 20/22, Chrome FR/EN and Chrome MFA/PostgreSQL runs;
- migration integrity lock 001–040 is green;
- runtime DB least-privilege matrix and target-environment preflight are green;
- supply-chain workflow pins are unchanged or explicitly reviewed.

Otherwise: **NO-GO**.

## 2. Staging infrastructure

GO only if:

- staging is a dedicated Facturations application;
- staging has a dedicated PostgreSQL database;
- HTTPS certificate and hostname are valid;
- Node is not directly internet-exposed outside the trusted proxy;
- `NODE_ENV=production` startup gate passes;
- `/health` returns 200;
- `/ready` returns 200;
- `scripts/staging-readonly-preflight.js` passes;
- graceful shutdown has been exercised without partial requests.

Otherwise: **NO-GO**.

## 3. Database

GO only if:

- migrations 001–040 are reviewed and applied in sequence;
- migration integrity lock passes;
- migrations are executed with a separate admin/migration identity;
- runtime application identity passes `npm run check:runtime-db`;
- runtime identity is not owner/superuser and cannot create roles/DB/schema objects;
- production backup is encrypted;
- retention and off-host/off-account copy are defined;
- a production-like backup has been restored into an isolated recovery environment;
- RPO/RTO are documented.

Otherwise: **NO-GO**.

## 4. Secrets and authentication

GO only if:

- `FACTURATIONS_DATABASE_URL`, TOTP key and provider secrets are stored outside the repository;
- secrets are different from development/staging where required;
- staff MFA enrollment and recovery procedure are tested;
- OWNER/STAFF authorization boundaries are reviewed;
- passwordless client token expiry/replay rules are verified;
- session revocation is tested;
- secret rotation ownership is documented.

Otherwise: **NO-GO**.

## 5. Legal/fiscal invoice identity

GO only if:

- legal issuer name/address are validated;
- GST/QST/tax registration data are validated by the responsible accounting/legal person;
- the verified issuer profile matches those records;
- sample qualified PDFs are reviewed;
- tax treatment/mappings are approved;
- no claim of fiscal certification/homologation is made without independent evidence.

Otherwise: **NO-GO for real invoices**.

## 6. Wave / issuance

GO only if:

- the exact Wave business/account mapping is verified;
- product/customer/tax mappings are reviewed;
- a controlled non-customer staging/test issuance is authorized;
- provider ID and official invoice number reconcile correctly;
- ambiguous/timeout behavior is tested;
- duplicate/retry protection is proven;
- rollback/reconciliation procedure is documented.

Until then, Wave writes remain disabled.

## 7. Email delivery

GO only if:

- a real provider is selected and configured privately;
- staging uses only allowlisted test recipients;
- webhook signature verification is validated against official provider behaviour;
- ACCEPTED is not treated as DELIVERED;
- bounce/complaint paths are tested;
- customer addresses are not enabled until the staging evidence is approved.

Until then, `SIMULATED_EMAIL` remains the only authorized mode.

## 8. Payments

If real payment/refund execution is enabled, GO only if:

- the processor is explicitly selected;
- credentials are segregated;
- webhook verification is tested;
- idempotency/reconciliation are proven;
- refund/chargeback handling is documented;
- accounting ownership is defined.

If payments remain evidence/read-only, mark this section **NOT ENABLED**, not PASS.

## 9. Observability / incident response

GO only if:

- structured redacted logs reach the approved destination;
- storage encryption and access controls are set;
- retention/deletion period is defined;
- alerting exists for 5xx/readiness/provider failures;
- incident owner and escalation contact are defined;
- proxy logs do not retain magic-link query tokens or dynamic identifiers.

Otherwise: **NO-GO**.

## 10. Release procedure

Before release:

1. freeze the exact release SHA;
2. record all green CI run IDs;
3. create/verify backup;
4. verify rollback target;
5. apply migrations with migration identity;
6. run runtime DB least-privilege preflight;
7. start application;
8. verify `/health` and `/ready`;
9. run HTTPS staging/production-safe read-only checks;
10. perform synthetic owner/client smoke;
11. enable external providers only after their own GO gates;
12. record release evidence in the private operations log.

## 11. Rollback

If startup/readiness, schema verification, authentication, provider reconciliation or critical customer workflow fails:

- stop new external writes;
- mark application not-ready;
- do not manually retry ambiguous provider operations;
- roll application code back to the last approved SHA when schema compatibility permits;
- use forward-fix migration rather than rewriting an applied migration;
- restore a database only under the approved disaster-recovery procedure;
- reconcile Wave/email/payment provider state before reopening writes.

## 12. Machine-readable GO / NO-GO dossier

GO only if the private evidence dossier for the exact release SHA also passes `npm run go-no-go:staging`. Synthetic CI evidence must never be substituted for REAL_GITHUB, REAL_STAGING, REAL_PROVIDER, HUMAN_REVIEW, REGULATORY_REVIEW, SECURITY_REVIEW or HOSTING_SIGNOFF gates.

Otherwise: **NO-GO**.

## Final definition of DONE

The **software implementation** is done when the final hardening PR is green and reviewed.

The **production launch** is done only when every applicable GO item above has external evidence and the responsible human explicitly records GO. Missing external evidence is a blocker, not something the code should fake.
