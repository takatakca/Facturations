# Wave network adapter — guarded test-only transport

This branch introduces the first HTTP transport capable of carrying the fixed Wave mutation contract, but it is **not wired into the application or provider runner**.

## Default state

`createWaveNetworkAdapter()` returns an adapter in `DISABLED` mode. Calling `execute()` fails before any fetch call.

The only network-capable construction mode is `AUTHORIZED_TEST_ONLY`. It requires all of the following at construction time:

- a private access token supplied at runtime, never committed;
- one explicit allowed Wave business ID;
- verified OAuth scopes including `invoice:write` or `invoice:*`;
- a bounded timeout;
- a fetch implementation.

There is no production/live activation mode in this module.

## Allowed requests

The adapter accepts only objects previously produced by the v2 mutation contract:

- `FacturationsCreateInvoice` using the exact fixed `invoiceCreate` document;
- `FacturationsApproveInvoice` using the exact fixed `invoiceApprove` document.

The Wave endpoint is fixed in code to `https://gql.waveapps.com/graphql/public`. Callers cannot supply another endpoint or arbitrary GraphQL.

For invoice creation, the persisted plan's Wave business ID must equal the adapter's explicitly authorized business ID. Approval must retain the exact invoice ID produced by the approved contract.

## Failure handling

Once `fetch` is invoked, transport failures that do not provide a trustworthy final provider result are conservative:

- timeout / aborted request -> outcome unknown;
- network exception -> outcome unknown;
- HTTP 5xx -> outcome unknown;
- unreadable, invalid or oversized successful body -> outcome unknown.

These signals are intended for the provider state machine so that an uncertain mutation cannot be blindly retried.

Authentication/access rejection is reported separately. The adapter never interprets GraphQL mutation success: the pure classifiers from `wave-mutation-contract-v2.js` remain responsible for checking returned invoice identity, state, currency, totals and taxes.

## Deliberately absent

This branch does **not**:

- import the adapter from `app.js`;
- read a Wave write token from environment configuration;
- execute any real Wave mutation in CI or tests;
- mark a local draft as issued;
- send an invoice email;
- take or reconcile payments;
- implement OAuth token refresh;
- implement real Wave reconciliation after an ambiguous mutation.

Before a first real mutation, an explicitly authorized Wave test business and token/scopes must be configured outside GitHub, the runner must persist its execution before network, and ambiguous outcomes must be connected to an actual read-only reconciliation strategy.
