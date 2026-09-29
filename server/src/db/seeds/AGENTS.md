# `server/src/db/seeds/` — the demo data

Two things per seeder: a `*.data.js` holding the values as plain data, and a
`*.seed.js` holding the idempotent insert function that applies them.

| Pair | Loads |
| ---- | ----- |
| `location.data.js` / `location.seed.js` | 15 zones, 45 service points, 45 routing vertices, 47 routing edges (43 bidirectional, 4 one-way) |
| `auth.data.js` / `auth.seed.js` | The four demo accounts and Jashim's `Bullet` vehicle |

`fare.data.js` holds the `dhaka-solo` v1 pricing policy, applied by `fare.seed.js`.

> **Adding or removing an edge needs the graph rebuilt.** `graph_edge_id` is that
> edge code's rank in byte order (`graph-ids.js`), and it is immutable in the
> database — a trigger rejects the update, because a stored route is a list of edge
> ids. So a new edge takes a rank some existing edge already holds. On an existing
> database, clear the edges first and let the seeder re-insert the whole set:
>
> ```sql
> DELETE FROM routing_edges;   -- then: npm run db:seed
> ```
>
> A database seeded from scratch needs none of this. Adding a *vertex* is the same
> story with `routing_vertices`.

## Why it matters

* **The data is separated from the insert** so the geography and the demo cast can
  be read, diffed and asserted on without a database. `test/unit/location.data.test.js`
  checks the coordinate bounds and the graph's shape — no live connection needed.
* **Everything re-runs.** `npm run db:seed` is idempotent, and the location seeder
  is also mounted into the container's `docker-entrypoint-initdb.d`. A seeder that
  inserted twice would corrupt the demo city on the second run.
* **One-way edges are intentional fixtures.** `gulshan-2-circle->niketon-gate`,
  `baily-road->siddheswari`, `farmgate->khamarbari` and
  `shapla-chattar->sadarghat` are one-way, which makes `niketon-gate`,
  `khamarbari` and `indira-road` unable to reach the rest of the graph. Tests use
  that as the "unreachable destination" case rather than inventing data.
* **The accounts are development-only.** They are created with a password from
  `DEMO_SEED_PASSWORD` (and `ALLOW_DEMO_SEED` in production), and they are what a
  frontend signs in with:

  ```text
  nusrat@example.com    passenger   (Banani Road 11 -> Mohakhali Bus Terminal
  rafiq@example.com     passenger    is the reference journey: 2214 m, 569 s,
  shirin@example.com    passenger    BDT 130 quoted solo at rush hour)
  jashim@example.com    driver      one vehicle: "Bullet", 3 seats
  password: DemoPass123!  (unless DEMO_SEED_PASSWORD says otherwise)
  ```

  These names are the ones `openapi.yaml` uses in its examples, and
  `test/unit/openapi.test.js` fails if a placeholder like `user1` appears instead.

## Depends on / depended on by

Depends on `../../db/prisma.js` and `../../utils/password.js`. Depended on by
`../seed.js`, by the integration suites (which call `prepareDatabase()` and
resolve the seeded rows), and by `test/helpers/drivers.js` for `POINTS` — the
seeded service point codes the fixtures use.

## Rules worth preserving

* A new seeder is idempotent (upsert or check-then-insert) and registered in
  `seed.js`.
* Data changes are additive where possible: tests and documentation reference the
  seeded codes, so renaming one is a breaking change across the repository.
