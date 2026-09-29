# `server/db/` — the schema

Hand-written, **idempotent** SQL migrations plus the seeders that load the demo
city, the pricing policy and the demo accounts. Nothing here is generated: these
files are the source of truth for the schema, and `prisma/schema.prisma` mirrors
them for the client.

## How it is applied

* `npm run db:migrate` (`src/db/migrate.js`) runs every `NN-*.sql` **in order, one
  transaction per file, on every run**. A file that is not idempotent will break
  the second `npm test` of the day.
* `01-schema.sql` and `02-seed.sql` are also mounted into the container's
  `docker-entrypoint-initdb.d`, so a fresh volume is usable before any migration
  runs.
* Prisma Migrate is deliberately **not** used to apply changes. `prisma migrate
  diff` is used as a check, and reports known, accepted drift: GiST indexes and
  the `DESC` parts of three indexes Prisma cannot express.

## Conventions a new migration must follow

1. **Idempotent by construction**: `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`,
   `ALTER TYPE … ADD VALUE IF NOT EXISTS`.
2. **Numbered, never renumbered.** An applied file is a record of what was run.
   When a rule in it turns out to be wrong, append a *convergence section* that
   drops the old constraint and adds the corrected one — `11-pool-fares.sql` §9–§11
   are the worked examples.
3. **`ALTER TYPE … ADD VALUE` cannot be used in the same transaction**, so a
   migration must never test a column against a value it just added.
4. **Name things the way Prisma does** unless there is a reason not to: an inline
   `REFERENCES` gets `<table>_<column>_fkey` for free, and an index gets
   `<table>_<column>_idx`. Write foreign keys inline rather than naming them.
5. **Every rule gets a constraint**, and it gets a comment saying what it prevents.
6. **The lifecycle CHECKs are the contract**: a status and the timestamps that
   justify it cannot disagree (`ride_pools_lifecycle_consistent`,
   `pool_stops_lifecycle_consistent`, `pool_members_lifecycle_consistent`,
   `ride_requests_lifecycle_consistent`). A fixture that writes a status by hand
   must write the timestamp too.
7. **A convergence section must not contradict a later file.** Every file re-runs
   on every `db:migrate`, so a section that re-adds a *superseded* definition is
   applied to data written under the newer one -- and fails, on the second run,
   in the one place nobody looks. This was real: §9 of `11-pool-fares.sql`
   re-adds `pool_fare_calculations_totals_consistent` without the rounding term
   that `14-fare-rounding.sql` adds, so it rejected every pooled fare carrying a
   non-zero adjustment. It is now guarded on that column not existing yet. Either
   a re-add is still the newest definition, or it is conditional on the newer one
   being absent.

## What is here

| File | What it adds |
| ---- | ------------ |
| `01-schema.sql`, `02-seed.sql` | Extensions, enums, users/profiles/vehicles, zones and points |
| `04-auth.sql` | Authentication tables |
| `04-drop-transport-network.sql` | Removes the superseded network tables |
| `05-postgis-location.sql` | Spatial columns and GiST indexes |
| `06-pgrouting-routing.sql` | Routing vertices/edges, pgRouting |
| `07-fare-pricing.sql` | `fare_policies`, `fare_quotes`, the traffic profile |
| `08-ride-requests.sql` | `ride_requests`, `ride_events`, the transition trigger |
| `09-driver-dispatch.sql` | Driver availability, `ride_pools`, `pool_members`, `pool_stops`, `pool_events` |
| `10-pool-matching.sql` | Join offers, the pool-version guard, the candidate indexes |
| `11-pool-fares.sql` | `pool_fare_calculations` / `_legs` / allocations / shares |
| `12-driver-trip.sql` | `departed_at`, `pool_stops.completed_at`, the request's own start and completion, the trip's event values |
| `13-read-api.sql` | Read-path indexes only (the passenger/driver history and current-pool lookups) |
| `14-fare-rounding.sql` | `fare_rounding_unit` / `fare_rounding_adjustment` on quotes, allocations and calculations, and the widened totals constraint |

## Depends on / depended on by

Depends on nothing but PostgreSQL and the extension image
(`docker/db/Dockerfile`, tag `teslab/postgis-pgrouting:17-3.5`). Everything in
`server/src` depends on it: a column or constraint renamed here without a matching
change in `prisma/schema.prisma` and the services is a runtime failure.

## What future agents must preserve

* The append-only triggers (`ride_events`, `pool_events`, the fare ledger rows).
* The partial unique indexes that decide races: one active request per passenger,
  one active pool per driver, one pending offer per driver, one pending route
  change per pool, one `CURRENT` fare calculation per pool, one member per request.
* The `Unsupported` spatial columns are written only through parameterised raw SQL
  with `ST_GeomFromGeoJSON`.
