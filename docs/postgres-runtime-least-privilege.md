# PostgreSQL runtime least-privilege policy

Facturations separates **schema administration/migration** from the **runtime application role**.

The runtime role must be able to use the application schema and perform only the data operations the application needs. It must not be a database administrator.

## Runtime preflight

Run in the target staging/production application environment:

```bash
npm run check:runtime-db
```

The command reads only `FACTURATIONS_DATABASE_URL`, connects with that exact runtime identity, verifies both the role/transport policy **and the exact application privilege matrix** (tables, views, sequences and restricted TOTP columns), and prints only PASS/FAIL plus the transport classification. It never prints the role name, hostname, URL, password or SQL error details.

## Rejected capabilities

The preflight fails if the runtime identity is:

- PostgreSQL superuser;
- allowed to create roles;
- allowed to create databases;
- replication-capable;
- able to bypass RLS;
- allowed to CREATE at database level;
- allowed to CREATE in the public schema;
- owner of application relations/sequences/views/materialized views;
- owner of application functions;
- member of privileged predefined PostgreSQL roles;
- connected to a remote database without TLS.

The role must have LOGIN and USAGE on the application schema.

## Deployment model

Use two different identities:

1. **migration/admin identity** — private, used only during controlled schema changes;
2. **runtime identity** — used by the Node application after migrations, with the preflight above passing.

Do not put migration/admin credentials in the Node application environment.

## Evidence required before GO-LIVE

Record, outside this public repository:

- date/time of the preflight;
- environment name;
- release SHA;
- PASS result;
- who performed the check;
- evidence that migrations used a separate identity;
- evidence that the Node process uses the restricted runtime identity.

Do not record credentials, connection strings or role names in public issues/logs.
