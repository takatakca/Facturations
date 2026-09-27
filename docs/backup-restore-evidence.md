# Backup and restore evidence

A backup is not considered operationally useful until restoration has been demonstrated.

## Automated CI drill

`npm run test:backup-restore` is deliberately restricted to:

- PostgreSQL on `localhost` or `127.0.0.1`;
- port 5432;
- database `facturations_test`;
- disposable credentials;
- absence of `FACTURATIONS_DATABASE_URL`.

The drill:

1. creates one synthetic marker in the disposable database;
2. captures a canonical proof of public schema structure and row counts;
3. runs PostgreSQL 16 `pg_dump` in custom format;
4. creates `facturations_restore_test`;
5. restores with PostgreSQL 16 `pg_restore --exit-on-error`;
6. verifies the synthetic marker;
7. compares columns, constraints, indexes, triggers, views, functions, sequences and table row counts;
8. hashes the proof with SHA-256;
9. deletes the restored database and dump artifact.

No row contents are printed to CI logs.

## What this proves

The CI evidence proves that, for the current synthetic schema and data:

- a logical dump can be created;
- the dump can be restored into a fresh database;
- important schema objects survive;
- row counts survive;
- a known synthetic record survives.

It also catches migration changes that make the current logical restore procedure fail.

## What this does not prove

It does **not** prove production backup coverage.

Before production, GROUPE TAKATAK must record and verify:

- where production backups are stored;
- encryption at rest and in transit;
- backup credentials separated from application credentials;
- retention policy;
- RPO and RTO targets;
- scheduled backup frequency;
- off-host/off-account copy strategy;
- access control and audit trail;
- restore procedure into an isolated recovery environment;
- periodic restore drills using approved non-production copies;
- deletion/retention obligations for personal information;
- responsible person and escalation path when a backup or restore fails.

Production restore evidence must identify the backup version/date and the recovery environment without placing customer data, credentials or database dumps in GitHub.

## Safety boundary

The repository drill must never be relaxed to accept a production hostname or database name. A real production backup job belongs in the private hosting/operations layer, not in this public repository.
