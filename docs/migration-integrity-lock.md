# Migration integrity lock

Historical database migrations are deployment artifacts. Once reviewed and used to build a database, silently rewriting them makes later recovery, audit and environment comparison unreliable.

## Locked set

`db/migration-integrity-lock.json` currently locks migrations **001 through 040**.

For every migration the lock records:

- exact filename and sequence;
- exact byte length;
- Git blob SHA-1 content identifier.

`npm run check:migrations` recomputes the Git blob identifier from the exact bytes on disk and verifies the complete ordered set.

## Fail-closed conditions

Verification fails if:

- a historical migration changes by even one byte;
- a locked migration is removed;
- a new numbered migration exists but is not added to the lock;
- numbering is not continuous;
- filename format is invalid;
- lock metadata is malformed;
- stored byte length or blob identifier differs.

The disposable database setup also performs this verification before applying migrations.

## Adding a future migration

A legitimate new migration must be append-only:

1. create the next sequential SQL file, for example `030_...`;
2. review it as a new migration instead of editing 001–040;
3. add its exact size and Git blob identifier to the lock;
4. increment `lockedThrough`;
5. run the full Node 20/22, PostgreSQL restore and browser CI;
6. have the lock change independently reviewed before merge.

If a historical migration genuinely must change before any real deployment, the migration **and lock change must appear explicitly in the same reviewed PR**. After production use, schema corrections should be new forward migrations rather than rewriting history.

## Security boundary

The lock is a repository integrity control, not a digital signature or independent notarization. A person with write access can propose changes to both SQL and lock.

Therefore its production value depends on:

- protected `main`;
- required CI;
- independent review;
- retained Git history;
- controlled deploy permissions.

Those controls are tracked separately in issue #41 and the production audit.
