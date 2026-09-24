# Guarded two-phase Wave runner

This branch connects the persisted issuance chain to the fixed Wave mutation contract and guarded network adapter, while CI still uses only a fake fetch implementation.

## Sequence

1. Load the immutable Wave mapping for the owner authorization.
2. Prepare or reuse the provider execution row.
3. Persist a `CREATE_DRAFT` network-attempt marker **before** HTTP.
4. Send only the fixed `invoiceCreate(... status: DRAFT)` contract.
5. Validate the response against customer, currency, tax and total expectations.
6. Persist the confirmed provider draft ID in `facturations_wave_create_confirmations`.
7. Persist an `APPROVE_INVOICE` network-attempt marker **before** HTTP.
8. Send only the fixed `invoiceApprove` contract for that exact provider invoice ID.
9. Confirm the final provider state/number and mark the provider execution `CONFIRMED`.

No `invoiceSend` operation exists in this runner.

## Duplicate prevention

A provider draft confirmation is stored separately from the final execution. If approval is safely retryable, the next run skips `invoiceCreate` and retries only approval against the same provider invoice.

Each network mutation is journaled with the current execution version before the HTTP call. If a process restarts while the execution is `IN_PROGRESS`:

- a prior CREATE attempt without a persisted create confirmation requires reconciliation;
- a persisted create confirmation with a prior APPROVE attempt requires reconciliation;
- a persisted create confirmation with no APPROVE attempt can safely resume approval;
- an execution already `CONFIRMED` returns idempotently with no network.

This deliberately favors manual/read-only reconciliation over duplicate provider mutations.

## New database objects

- migration 014: immutable `facturations_wave_create_confirmations`;
- migration 015: append-only `facturations_wave_network_attempts`.

Neither table stores access tokens, request bodies, customer names, email bodies or PDF content.

## Current boundary

The network adapter can only be constructed as `AUTHORIZED_TEST_ONLY`, and this runner is **not imported by app.js**. Automated tests provide a synthetic token and a fake `fetch`; no request reaches Wave.

A real authorized test requires separate owner approval, a Wave test business, runtime-only credentials/scopes, and a read-only reconciliation implementation for ambiguous CREATE/APPROVE outcomes before any external mutation is attempted.
