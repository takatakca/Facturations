# CI supply-chain hardening

The CI workflows are part of the production control surface. A green application test is not enough if the workflow can silently execute different third-party code.

## Immutable action references

External GitHub Actions are referenced by full 40-hex commit SHA.

The workflow comments may describe the major release family, but the executable reference is the commit SHA.

Current pinned actions:

- `actions/checkout`;
- `actions/setup-node`.

Checkout also uses `persist-credentials: false` so the workflow token is not retained in the repository's local Git configuration after checkout.

## PostgreSQL image

The PostgreSQL 16 service image is pinned by SHA-256 image digest instead of relying only on a mutable `postgres:16` tag.

A deliberate update of PostgreSQL therefore requires an explicit code change and a full CI rerun.

## Runner and matrix evidence

Workflows use `ubuntu-24.04` rather than `ubuntu-latest` to avoid an unreviewed runner-generation jump.

The Node 20/22 matrix uses `fail-fast: false`. If one version fails, the other version is still allowed to complete, preserving independent evidence for both environments.

Node remains selected by maintained major version intentionally so CI continues detecting patch-level compatibility changes within Node 20 and Node 22.

## Regression guard

`tests/ci-supply-chain.test.js` fails if:

- a third-party `uses:` reference is not a full commit SHA;
- checkout credentials are persisted;
- PostgreSQL loses its digest pin;
- `ubuntu-latest` returns;
- the Node matrix loses `fail-fast: false`.

## Remaining external controls

This repository cannot itself prove:

- GitHub organization/account MFA;
- branch/ruleset enforcement on `main`;
- independent reviewer identity;
- secret-scanning settings;
- Dependabot/security alert policy;
- runner infrastructure integrity beyond GitHub's hosted-runner trust boundary.

Those settings must be reviewed separately and recorded as operational evidence.
