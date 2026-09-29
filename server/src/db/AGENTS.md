# `server/src/db/` — the Prisma client, the migrator and the seeders

Four things, and only one of them owns the schema.

| File | What it does |
| ---- | ------------ |
| `prisma.js` | The single `PrismaClient`, built on `@prisma/adapter-pg`. Exports `prisma`, `checkDatabase()` and `disconnect()`. |
| `migrate.js` | `npm run db:migrate`: runs every `server/db/NN-*.sql` in order, one transaction per file, **on every run**. |
| `seed.js` | `npm run db:seed`: idempotent seeders for locations, pricing and the demo accounts. |
| `seeds/` | The seed data and its insert functions — see `seeds/AGENTS.md`. |

## Why it matters

* **The SQL files are the source of truth, not Prisma Migrate.** `migrate.js`
  applies hand-written, idempotent, cumulative files. Prisma Migrate is
  deliberately unused: it cannot express the `CHECK` constraints, the partial
  unique indexes or the GiST indexes this schema depends on. `prisma migrate diff`
  is used only as a *check*, and its expected drift is documented.
* **Idempotency is a hard requirement.** Every file is re-applied on every
  `db:migrate`, and `npm test` runs it too. A file that is not idempotent breaks
  the *second* test run of the day.
* **The client is a singleton.** One `PrismaClient` per process, with the
  connection string taken from `config/env.js` so the API and the CLI cannot
  disagree. Under `NODE_ENV=test` it also emits `query` events, which is how the
  N+1 test counts queries — that switch is here rather than in a suite because the
  client is a module singleton.
* **Spatial columns are `Unsupported` in Prisma**, so geometry goes through
  parameterised `$queryRawUnsafe`. Note that `$queryRawUnsafe` returns the rows
  array itself, not `{ rows }`.

## What a frontend indirectly depends on

The seed decides the demo data every example and test uses — the 15 zones, 45
service points, 47 routing edges, one pricing policy (`dhaka-solo` v1) and four
accounts (Nusrat and Rafiq and Shirin as passengers, Jashim as the driver, one
`Bullet` vehicle). Because it is idempotent and stable, a client can be developed
against those ids and codes.

## Depends on / depended on by

Depends on `@prisma/client`, `@prisma/adapter-pg`, `../config/env.js` and
`../../db/*.sql` (migrations are read from disk). Depended on by every service
(through `prisma`) and by `test/helpers/db.js`.

## Rules worth preserving

* Never add a query to `prisma.js` — it is the client, not a repository.
* Never edit an applied migration. Append a convergence section, or a new numbered
  file.
* Never let a seeder become non-idempotent: it re-runs on every `db:seed`.
