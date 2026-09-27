# TeslaB

**A ride-pooling demo.** A passenger asks for a ride, nearby drivers are offered it, the one
who accepts collects them — and other passengers travelling the same way are folded into the
same car, with the bill split leg by leg. Two frontends (a passenger app and a driver console)
sit on one Express API over PostgreSQL, with PostGIS for geography and pgRouting for real road
distances.

The point of the project is not the screens. It is that **every rule lives on the server and is
enforced by the database**, so no client can invent a state transition, a price or an identity.

| | |
| --- | --- |
| **Status** | Feature-complete through the trip milestone; deployment pending |
| **Frontends** | Next.js 16 App Router — passenger screens and a driver console (7 screens) |
| **Backend** | Express 5 REST API — 10 route modules |
| **Database** | PostgreSQL 17 + PostGIS + pgRouting — 21 tables, 25 triggers |
| **Contract** | `server/openapi.yaml`, served at `GET /api/docs`, verified by a unit test |
| **Tests** | `node --test` — 1136 tests across 222 suites, 0 failures |

---

## Summary

TeslaB implements the whole loop a shared-ride product needs, end to end and runnable locally:

**Quote → request → dispatch → match → pool → drive → settle.**

A passenger picks a pickup and a destination, and the server prices the journey with pgRouting
over a real road graph. Requesting the ride consumes that quote. A dispatcher then shortlists
drivers by straight-line radius, routes each candidate to the pickup, and offers the ride to the
best one, who has 30 seconds to answer. On acceptance a *pool* is created; later requests that
can be served by that same car without breaking the waiting-time, detour or capacity rules are
folded into it. The driver then drives the trip through six commands, and each passenger's fare
is recalculated from the legs they were actually aboard for.

Everything a client displays is a value the server published — `allowedActions` for the driver,
`stage` and `nextAction` for the passenger, `cancellable` for a request. Neither frontend
re-derives a rule.

## Problem statement

Ride-hailing demos usually stop at *"passenger books, driver accepts"*. The difficult parts are
the ones after that, and they are what this project was built to answer:

1. **Which driver should get the ride?** Not simply the nearest one. A driver 1 km away in a
   straight line can be 3 km from the pickup by road, and a driver who has not reported their
   location in five minutes is not somewhere a passenger can be collected from.
2. **Two passengers, one car.** Adding a second passenger changes the route for the first. It is
   only worth doing if the detour is small, the car has room, and the first passenger is not
   made materially late.
3. **Who owes what?** Splitting a pooled fare fairly is not division by two. Each passenger
   should pay only for the legs they were aboard, never more than the solo fare they accepted,
   and never more than they were paying a moment ago.
4. **The client cannot be trusted.** A fare, a state transition and an identifier are exactly the
   things a browser must never be able to choose.

So the question the project answers is: **can a shared-ride product be built where every rule is
a server-side, database-enforced invariant — and demonstrated end to end, including the parts
beyond the happy path?**

The answer it settles on is yes, and the mechanism is a specific one: rules are written once as
pure, unit-tested data (`ride.status.js`, `dispatch.rules.js`, `matching.rules.js`,
`pool-fare.rules.js`, `trip.rules.js`), and the services, the SQL constraints and the tests all
read from that single definition. Where a guarantee matters, a `CHECK`, a trigger, a foreign key
or a partial unique index stands behind it — not just a service-level check.

## Features implemented

**Accounts and identity**
- Registration and sign-in with one endpoint for both roles; bcrypt at cost 10; no account
  enumeration (an unknown email and a wrong password answer identically).
- Session as a signed JWT in an **HttpOnly** cookie — no token in JavaScript, no `localStorage`.
- `PASSENGER` / `DRIVER` roles (with `ADMIN` reserved), exactly one profile per user.
- `requireAuth` + `requireRole` guards. Another owner's resource is a deliberate **404**; a 403
  only ever means "wrong role".

**Place, distance and price**
- 15 zones and 45 service points seeded from a Dhaka transport graph, anchored to a routing
  graph of 45 vertices and 46 edges — including 4 one-way streets.
- `POST /routes/estimate` — pgRouting Dijkstra over directed edges, with rush-hour and normal
  traffic profiles chosen from configurable windows.
- Versioned fare policies and immutable, auditable quotes with a full breakdown. Money is exact
  decimal (`Prisma.Decimal` + `numeric`), never a float, and final fares are rounded to a
  policy-defined unit.

**Ride requests**
- `Idempotency-Key` required: a replay returns the original ride instead of creating a second.
- One active request per passenger, enforced by a partial unique index.
- A search window with an expiry sweep, and cancellation while waiting with a recorded reason.

**Dispatch and pools**
- Two-stage driver search — PostGIS radius shortlist, then routed approach time — with scoring
  and tie-breaking expressed as data, not magic numbers.
- Offers that expire in 30 seconds, carry a refusal reason, and are never repeated to a driver
  who has already let one lapse.
- Pool-first matching: a waiting request tries to join a compatible pool before it is offered a
  driver of its own. Capacity, waiting-time and detour limits are enforced per segment and per
  passenger.

**Shared fares**
- Leg-by-leg costing, split by who was actually aboard each leg.
- Two per-passenger caps (the accepted solo fare, and the previous pooled fare), because a
  passenger must never be made worse off by somebody else joining.
- A deferred constraint trigger proves each leg's shares sum to the leg cost **exactly** — the
  database refuses to commit a fare that does not balance.

**Trip execution**
- Pool lifecycle `FORMING → DRIVER_EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED`.
- Six driver commands (depart, arrive, pick up, start, drop off, complete). None takes a body;
  all are idempotent by state, so a retry cannot move a timestamp or duplicate an event.
- Append-only `ride_events` and `pool_events` timelines that refuse `UPDATE` by trigger.

**Read APIs**
- Passenger: current ride, history, and one ride in detail with a derived `stage`, a
  `nextAction`, and a timeline filtered by audience.
- Driver: the current pool with its published `allowedActions`, plus every pool they have driven.
- Reads are projections, not loops — the suites count SQL queries to prove a page costs the same
  however many rows it returns.

**Two frontends**
- Passenger: sign in/up, choose locations, watch a live fare estimate, request a ride, track it
  as it progresses, and cancel while it is still waiting.
- Driver: go online, receive offers, accept or decline, then execute the whole trip from an
  ordered stop list, and review past trips.

## Architecture

```mermaid
flowchart TB
    subgraph actors["Who uses it"]
        direction LR
        pax(["Passenger"])
        drv(["Driver"])
    end

    subgraph web["Next.js 16 client &middot; localhost:3000"]
        direction TB
        screens["App Router screens<br/>/ &nbsp; /signin &nbsp; /signup &nbsp; /status<br/>/ride &nbsp; /track &nbsp; /driver"]
        guards["Server-side guards<br/>lib/session.js"]
        widgets["Client components<br/>poll for state changes"]
        apiClient["lib/api.js<br/>one fetch wrapper"]
    end

    subgraph api["Express 5 API &middot; localhost:4000"]
        direction TB
        middleware["Middleware<br/>cors &middot; json &middot; cookies<br/>requireAuth &middot; requireRole"]
        routeMods["10 route modules under /api"]
        controllers["Controllers"]
        services["Services &mdash; the domain"]
        pure["Pure rules modules (unit tested)<br/>ride.status &middot; dispatch &middot; matching<br/>pool.fare &middot; trip"]
        orm["Prisma + adapter-pg"]
    end

    subgraph data["PostgreSQL 17 &middot; PostGIS + pgRouting &middot; localhost:55432"]
        direction TB
        tables["21 tables<br/>CHECKs &middot; 25 triggers &middot; unique indexes"]
        files["server/db/NN-*.sql<br/>idempotent migrations + seeds"]
    end

    contract["openapi.yaml<br/>the API contract, served at /api/docs"]
    suite["node --test<br/>unit + integration suites"]

    pax --> screens
    drv --> screens
    screens --> guards
    guards --> widgets
    widgets --> apiClient
    apiClient -->|"HTTP /api/*<br/>HttpOnly cookie, never a token in JS"| middleware
    middleware --> routeMods
    routeMods --> controllers
    controllers --> services
    services --> pure
    services --> orm
    orm -->|"parameterised SQL"| tables
    files -.->|"npm run db:migrate<br/>npm run db:seed"| tables
    contract -.->|"checked against"| routeMods
    suite -.->|"exercises"| services
    suite -.->|"runs against"| tables

    classDef place fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
    classDef app fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    classDef domain fill:#dcfce7,stroke:#16a34a,color:#052e16
    classDef store fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef side fill:#f4f4f5,stroke:#71717a,color:#27272a,stroke-dasharray:4 3

    class pax,drv place
    class screens,guards,widgets,apiClient,middleware,routeMods,controllers app
    class services,pure,orm domain
    class tables,files store
    class contract,suite side
```

Reading it top to bottom:

- **Purple** is request handling. `lib/api.js` is the only place the client calls `fetch`, and the
  session cookie is `HttpOnly`, so nothing in the browser can read a token.
- **Green** is where the domain lives. The pure rules modules are the single definition shared by
  the services, the SQL constraints and the tests — which is why neither frontend derives a rule.
- **Amber** is persistence. PostGIS supplies geography, pgRouting supplies real roads, and the
  tables carry 25 triggers plus the CHECK constraints that make the rules unbreakable.
- **Grey, dashed** are the two mechanisms that keep the rest honest: `openapi.yaml` must document
  every mounted route (a unit test fails the build otherwise), and the suites exercise the
  services against a real database.

The diagram also exists standalone at [`docs/architecture.mmd`](docs/architecture.mmd).

## Database diagram (ERD)

```mermaid
erDiagram
    USERS {
        uuid id PK
        text name
        text email UK
        enum role
        boolean active
        text password_hash
    }
    PASSENGER_PROFILES {
        uuid id PK
        uuid user_id FK
    }
    DRIVER_PROFILES {
        uuid id PK
        uuid user_id FK
        enum status
        uuid current_service_point_id FK
        uuid active_vehicle_id FK
        timestamptz last_seen_at
    }
    VEHICLES {
        uuid id PK
        uuid driver_id FK
        text name
        integer seat_capacity
        boolean active
    }
    SERVICE_ZONES {
        uuid id PK
        text code
        text name
        boolean active
    }
    SERVICE_POINTS {
        uuid id PK
        uuid zone_id FK
        uuid routing_vertex_id FK
        text code
        text name
        geography location
    }
    ROUTING_VERTICES {
        uuid id PK
        bigint graph_node_id
        text code
        geography location
    }
    ROUTING_EDGES {
        uuid id PK
        bigint graph_edge_id
        uuid source_vertex_id FK
        uuid target_vertex_id FK
        integer distance_meters
        integer normal_duration_seconds
        integer rush_hour_duration_seconds
        boolean bidirectional
    }
    FARE_POLICIES {
        uuid id PK
        text code
        integer version
        numeric base_fare
        numeric per_kilometer_rate
        numeric per_minute_rate
        numeric minimum_fare
        numeric fare_rounding_unit
        timestamptz effective_from
        timestamptz effective_to
    }
    FARE_QUOTES {
        uuid id PK
        uuid passenger_profile_id FK
        uuid fare_policy_id FK
        uuid origin_service_point_id FK
        uuid destination_service_point_id FK
        integer distance_meters
        integer duration_seconds
        numeric final_fare
        numeric fare_rounding_adjustment
        timestamptz expires_at
    }
    RIDE_REQUESTS {
        uuid id PK
        uuid passenger_profile_id FK
        uuid fare_quote_id FK "unique"
        uuid pickup_service_point_id FK
        uuid dropoff_service_point_id FK
        enum status
        timestamptz requested_at
        timestamptz search_expires_at
        timestamptz cancelled_at
        enum cancellation_reason
        text idempotency_key
    }
    RIDE_EVENTS {
        uuid id PK
        uuid ride_request_id FK
        integer sequence
        enum event_type
        uuid actor_user_id FK
        enum previous_status
        enum new_status
    }
    DISPATCH_OFFERS {
        uuid id PK
        uuid ride_request_id FK
        uuid driver_profile_id FK
        uuid vehicle_id FK
        uuid ride_pool_id FK
        enum offer_type
        enum status
        timestamptz expires_at
        jsonb proposal_snapshot
    }
    RIDE_POOLS {
        uuid id PK
        uuid driver_profile_id FK
        uuid vehicle_id FK
        enum status
        integer capacity_snapshot
        integer version
        timestamptz departed_at
        timestamptz completed_at
    }
    POOL_MEMBERS {
        uuid id PK
        uuid ride_pool_id FK
        uuid ride_request_id FK "unique"
        enum status
        timestamptz picked_up_at
        timestamptz dropped_off_at
    }
    POOL_STOPS {
        uuid id PK
        uuid ride_pool_id FK
        uuid ride_request_id FK
        uuid pool_member_id FK
        uuid service_point_id FK
        enum stop_type
        integer sequence
        enum status
        timestamptz completed_at
    }
    POOL_EVENTS {
        uuid id PK
        uuid ride_pool_id FK
        integer sequence
        enum event_type
        uuid actor_user_id FK
    }
    POOL_FARE_CALCULATIONS {
        uuid id PK
        uuid ride_pool_id FK
        uuid pricing_policy_id FK
        integer pool_version
        enum status
        text shared_fare_rule_version
        numeric total_final_passenger_fare
        numeric fare_rounding_unit
        timestamptz finalized_at
    }
    POOL_FARE_LEGS {
        uuid id PK
        uuid fare_calculation_id FK
        integer sequence
        uuid from_pool_stop_id FK
        uuid to_pool_stop_id FK
        integer distance_meters
        numeric total_leg_cost
    }
    PASSENGER_FARE_ALLOCATIONS {
        uuid id PK
        uuid fare_calculation_id FK
        uuid pool_member_id FK
        uuid ride_request_id FK
        numeric accepted_solo_fare
        numeric uncapped_pooled_fare
        numeric final_fare
        numeric fare_rounding_adjustment
    }
    PASSENGER_FARE_LEG_SHARES {
        uuid id PK
        uuid passenger_fare_allocation_id FK
        uuid pool_fare_leg_id FK
        integer onboard_passenger_count
        numeric share_ratio
        numeric allocated_amount
    }

    USERS ||--o| PASSENGER_PROFILES : "is a"
    USERS ||--o| DRIVER_PROFILES : "is a"
    DRIVER_PROFILES ||--o{ VEHICLES : "owns"
    DRIVER_PROFILES |o--o| VEHICLES : "driving now"
    SERVICE_POINTS |o--o{ DRIVER_PROFILES : "waiting at"
    SERVICE_ZONES ||--o{ SERVICE_POINTS : "groups"
    ROUTING_VERTICES ||--o{ SERVICE_POINTS : "anchors"
    ROUTING_VERTICES ||--o{ ROUTING_EDGES : "leaves"
    ROUTING_VERTICES ||--o{ ROUTING_EDGES : "arrives"
    PASSENGER_PROFILES ||--o{ FARE_QUOTES : "asks for"
    FARE_POLICIES ||--o{ FARE_QUOTES : "prices"
    SERVICE_POINTS ||--o{ FARE_QUOTES : "from"
    SERVICE_POINTS ||--o{ FARE_QUOTES : "to"
    PASSENGER_PROFILES ||--o{ RIDE_REQUESTS : "requests"
    FARE_QUOTES ||--o| RIDE_REQUESTS : "authorises"
    SERVICE_POINTS ||--o{ RIDE_REQUESTS : "picks up at"
    SERVICE_POINTS ||--o{ RIDE_REQUESTS : "drops off at"
    RIDE_REQUESTS ||--o{ RIDE_EVENTS : "records"
    USERS |o--o{ RIDE_EVENTS : "acted"
    RIDE_REQUESTS ||--o{ DISPATCH_OFFERS : "offered as"
    DRIVER_PROFILES ||--o{ DISPATCH_OFFERS : "receives"
    VEHICLES ||--o{ DISPATCH_OFFERS : "with"
    RIDE_POOLS |o--o{ DISPATCH_OFFERS : "join offer for"
    DRIVER_PROFILES ||--o{ RIDE_POOLS : "drives"
    VEHICLES ||--o{ RIDE_POOLS : "driven with"
    RIDE_POOLS ||--o{ POOL_MEMBERS : "carries"
    RIDE_REQUESTS ||--o| POOL_MEMBERS : "occupies"
    RIDE_POOLS ||--o{ POOL_STOPS : "scheduled as"
    POOL_MEMBERS ||--o{ POOL_STOPS : "serves"
    RIDE_REQUESTS ||--o{ POOL_STOPS : "stop for"
    SERVICE_POINTS ||--o{ POOL_STOPS : "located at"
    RIDE_POOLS ||--o{ POOL_EVENTS : "records"
    USERS |o--o{ POOL_EVENTS : "acted"
    RIDE_POOLS ||--o{ POOL_FARE_CALCULATIONS : "settles"
    FARE_POLICIES ||--o{ POOL_FARE_CALCULATIONS : "prices"
    POOL_FARE_CALCULATIONS ||--o{ POOL_FARE_LEGS : "measured as"
    POOL_STOPS ||--o{ POOL_FARE_LEGS : "bounds"
    POOL_FARE_CALCULATIONS ||--o{ PASSENGER_FARE_ALLOCATIONS : "split into"
    POOL_MEMBERS ||--o| PASSENGER_FARE_ALLOCATIONS : "is billed"
    RIDE_REQUESTS ||--o{ PASSENGER_FARE_ALLOCATIONS : "billed for"
    PASSENGER_FARE_ALLOCATIONS ||--o{ PASSENGER_FARE_LEG_SHARES : "itemised as"
    POOL_FARE_LEGS ||--o{ PASSENGER_FARE_LEG_SHARES : "shared as"
```

Read it in five bands, which is also the order the data is created:

| Band | Tables | What it holds |
| ---- | ------ | ------------- |
| **Reference** | `service_zones`, `service_points`, `routing_vertices`, `routing_edges` | Where places are and how the roads connect |
| **Identity** | `users`, `passenger_profiles`, `driver_profiles`, `vehicles` | Who is asking, who is driving, in what |
| **Pricing** | `fare_policies`, `fare_quotes` | What a journey costs, and the quote that froze it |
| **The ride** | `ride_requests`, `ride_events`, `dispatch_offers`, `ride_pools`, `pool_members`, `pool_stops`, `pool_events` | The request, the offers made for it, the pool it became, and the append-only history of both |
| **The money** | `pool_fare_calculations`, `pool_fare_legs`, `passenger_fare_allocations`, `passenger_fare_leg_shares` | The pooled bill, its legs, and each passenger's itemised share of them |

Three relationships carry most of the design:

- `fare_quotes ||--o| ride_requests` — **one-to-(zero or one)**. A quote authorises at most one
  ride, which is what stops a quote being reused. It is a unique foreign key, not a convention.
- `ride_requests ||--o| pool_members` — a request occupies at most one seat. This is the index
  that makes "one passenger, one car" a fact rather than a hope.
- `passenger_fare_leg_shares` — the join table that makes the pooled fare auditable. Every leg's
  cost is decomposed here so that the shares provably sum back to it.

The ERD also exists standalone at [`docs/erd.mmd`](docs/erd.mmd). The columns shown are the keys
plus the fields that carry domain meaning; `server/db/NN-*.sql` is the source of truth for
everything else.

## Tech stack

| Layer | Technology | Notes |
| ----- | ---------- | ----- |
| **Client** | Next.js 16.3 (App Router), React 19.2 | JavaScript, not TypeScript — JSDoc typedefs in `lib/types.js` are the substitute |
| | Tailwind CSS v4, ESLint 9 | Styling and linting |
| **API** | Node.js ≥ 20, Express 5.1 | ESM throughout |
| | Prisma 7.10 + `@prisma/adapter-pg` | The only path to the database |
| | `bcryptjs`, `jsonwebtoken`, `cookie-parser`, `cors`, `morgan` | Auth and HTTP plumbing |
| **Data** | PostgreSQL 17 | Runs in Docker on host port **55432** |
| | PostGIS 3.5 | `geography(Point,4326)`, `geometry(LineString,4326)`, GiST indexes |
| | pgRouting 3.8 | `pgr_dijkstra` over the directed road graph |
| **Testing** | `node:test` | Unit suites plus integration suites against a real database |
| **Tooling** | npm workspaces, concurrently, Docker Compose | One install, one `npm run dev` |

Versions are pinned in the two `package.json` files and `docker/db/Dockerfile`, which is where
they should be read from; this table is a summary, not the lockfile.

## Prerequisites

- **Node.js ≥ 20** and npm (the repo uses npm workspaces).
- **Docker Desktop** (or Docker Engine + Compose) — the database image is built locally.
- **Free ports**: `3000` (client), `4000` (API), `55432` (PostgreSQL).

> **Why 55432?** PostgreSQL's default `5432` is commonly already taken by a locally installed
> server. This project publishes the container on `55432` to avoid the collision. If you want a
> different port, set `POSTGRES_PORT` in a root `.env` **and** update `DATABASE_URL` in
> `server/.env` to match.

## Environment variables

No secret is ever committed. Three example files are tracked, and each real file is gitignored:

| Example file (committed) | Copy to (gitignored) | Covers |
| ------------------------ | -------------------- | ------ |
| `.env.example` | `.env` | Optional Docker Compose overrides (only needed to change defaults) |
| `server/.env.example` | `server/.env` | The API: database URL, JWT secret, cookie and auth settings, and every tuning knob |
| `client/.env.local.example` | `client/.env.local` | How the browser and the dev proxy reach the API |

`server/.env.example` is the canonical reference: it documents **every** variable with a
paragraph explaining what changing it would do. The ones you actually have to care about:

| Variable | Where | Default | Purpose |
| -------- | ----- | ------- | ------- |
| `DATABASE_URL` | `server` | `postgres://postgres:postgres@localhost:55432/TeslaB` | Read by the API **and** the Prisma CLI |
| `JWT_SECRET` | `server` | insecure dev placeholder | **Required in production** — the server refuses to start without it |
| `DEMO_SEED_PASSWORD` | `server` | `DemoPass123!` | The password given to the demo accounts by `npm run db:seed` |
| `PORT` / `CLIENT_ORIGIN` | `server` | `4000` / `http://localhost:3000` | Listen port and the CORS origin |
| `FARE_PRICING_CODE` | `server` | `dhaka-solo` | Which fare policy prices a quote. The *version* is never configured — it is whichever version is effective at the journey's departure instant |
| `RUSH_HOUR_WINDOWS` | `server` | `07:30-10:30,16:30-20:00` | Half-open windows that decide rush-hour costs; malformed values stop the server at start-up |
| `NEXT_PUBLIC_API_URL` | `client` | empty | Empty means same-origin, proxied by the rewrite in `next.config.mjs` |
| `API_URL` / `API_PROXY_TARGET` | `client` | `http://localhost:4000` | Where the API actually runs, for server components and the dev proxy |

Two deliberate design choices worth knowing about the rest:

- **The API runs with no `.env` at all.** Every variable has a working development default, so a
  fresh clone starts without configuration. Production is the opposite: `JWT_SECRET` is required
  and the demo seeder refuses to run.
- **Prices are data, not configuration.** Publishing a new fare is inserting the next version of
  a policy, not a deployment — so the *code* selects the policy and the *instant* selects the
  version. See [Pricing versioning](#pricing-versioning).

## Local setup

```bash
# 1. Install workspace dependencies (client + server)
npm install

# 2. Create the local env files from the tracked examples
cp .env.example .env                             # optional: only to change Docker defaults
cp server/.env.example server/.env
cp client/.env.local.example client/.env.local

# 3. Build and start the database (PostgreSQL 17 + PostGIS + pgRouting)
npm run db:up

# 4. Apply the schema (server/db/*.sql) — idempotent, safe to re-run
npm run db:migrate

# 5. Load the demo data: zones, service points, the routing graph, pricing and the demo accounts
npm run db:seed

# 6. Run the API and the client together
npm run dev
```

Then open <http://localhost:3000>.

### Docker

The database is the only containerised part. `docker-compose.yml` builds `docker/db/Dockerfile`,
which starts from `postgis/postgis:17-3.5` and adds the `postgresql-17-pgrouting` package.

```bash
npm run db:up      # build (if needed) and start the container in the background
npm run db:logs    # follow the PostgreSQL logs
npm run db:psql    # open a psql shell
npm run db:down    # stop the container, keeping data
npm run db:reset   # stop, DELETE the volume, and start clean
```

> **Why a custom image?** The plain `postgres` image has no PostGIS library, so
> `CREATE EXTENSION postgis` fails. The upstream `postgis/postgis` image has no pgRouting, so
> `CREATE EXTENSION pgrouting` fails. This project needs both.

The volume `teslab-pgdata` persists across `db:down`. The first time it is created, the container
runs every `server/db/*.sql` automatically via `/docker-entrypoint-initdb.d`; after that,
`npm run db:migrate` is how the files are (re)applied.

### Migrations

`server/db/NN-*.sql` are hand-written, **idempotent and cumulative**: every `npm run db:migrate`
re-runs all of them, in order, against the current database. They use `IF NOT EXISTS` /
`DROP … IF EXISTS`, and a change to an already-applied file is expressed as a new convergence
section at the end rather than an edit in place.

`schema.prisma` is a hand-maintained *mirror* of the SQL, used for the typed client — not the
source of truth. `npm run db:generate` regenerates Prisma's client after a schema change.

<!-- EDIT SPACE: add any machine-specific setup notes (corporate proxy, WSL, Apple silicon,
     a different local Postgres already on 5432, etc.) here. -->

## Running the apps

```bash
npm run dev          # API (:4000) and client (:3000) together, via concurrently
npm run dev:server   # Express only, with node --watch
npm run dev:client   # Next.js only
```

| URL | What it is |
| --- | ---------- |
| <http://localhost:3000> | The client. `/` redirects by role; `/status` shows API and database health |
| <http://localhost:4000/api/health> | API and database status |
| <http://localhost:4000/api/docs> | The OpenAPI contract, served verbatim |

`npm run build` produces the production client; `npm start` runs both apps in production mode.

### Scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Run the API and the web client concurrently |
| `npm run dev:server` | Express only, with `node --watch` on port 4000 |
| `npm run dev:client` | Next.js dev server on port 3000 |
| `npm run build` | Production build of the Next.js client |
| `npm start` | Run both apps in production mode |
| `npm run lint` | ESLint for the client |
| `npm run db:up` / `db:down` / `db:reset` | Start / stop / recreate the database container |
| `npm run db:generate` | Regenerate the Prisma client from the schema |
| `npm run db:migrate` | Apply `server/db/*.sql` (idempotent) |
| `npm run db:seed` | Apply the demo seed (zones, graph, pricing, demo accounts) |
| `npm test` | The whole server suite — needs the database |

Three operational commands stand in for the schedulers this project does not have; each is the
operation a cron job or queue worker would run:

| Command | What it does |
| ------- | ------------ |
| `npm run ride-requests:expire --workspace server` | Expire ride requests whose search window has closed |
| `npm run dispatch:sweep --workspace server` | Expire overdue offers and re-offer waiting requests |
| `npm run pool-fares:recalculate --workspace server` | Repair sweep for pooled fare calculations |

## Running the tests

```bash
npm test                                            # everything (needs the database)
npm run test:unit --workspace server                # pure rules only, no database
npm run test:integration --workspace server         # HTTP + SQL suites
```

Current state: **1136 tests, 222 suites, 0 failures.**

Two things to know before you run them:

- **The database must be up** (`npm run db:up`, migrated and seeded first). The integration suites
  open real transactions and run real routing queries through pgRouting.
- **`--test-concurrency=1` is required** (already set in the npm script). The suites share one
  database; two files running at once corrupt each other's state, and the resulting failures look
  exactly like real bugs. Run the script, not `node --test` directly.

Those suites are the project's specification. They cover authentication, routing, fares, ride
requests, dispatch, matching, shared fares, the trip lifecycle and the read APIs.

## Demo credentials

Seeded by `npm run db:seed`. **Development and demo only — never seed these in production.**

| Actor | Email | Password | Role | Profile / vehicle |
| ----- | ----- | -------- | ---- | ----------------- |
| Nusrat | `nusrat@example.com` | `DemoPass123!` | `PASSENGER` | Passenger profile |
| Rafiq | `rafiq@example.com` | `DemoPass123!` | `PASSENGER` | Passenger profile |
| Shirin | `shirin@example.com` | `DemoPass123!` | `PASSENGER` | Passenger profile |
| Jashim | `jashim@example.com` | `DemoPass123!` | `DRIVER` | Driver profile + vehicle *Bullet* (3 seats) |

All four share the value of `DEMO_SEED_PASSWORD`, which defaults to `DemoPass123!`. To change it,
set the variable in `server/.env` and re-run `npm run db:seed`.

Sign in at `/signin` — one form for both roles, and the role decides where you land (`/ride` for a
passenger, `/driver` for a driver).

Two caveats:

- **`ada@example.com` and `alan@example.com` cannot sign in.** They come from `server/db/02-seed.sql`
  and predate authentication, so they have no password hash. The `/status` page lists them anyway,
  which is misleading.
- `npm test` re-seeds the database, which can reset the demo password and clear ride history.

To try the whole loop yourself, see [Driving the ride](#driving-the-ride).

## Deployment

<!-- EDIT SPACE: fill in the deployment URL once it exists. -->

| | |
| --- | --- |
| **Frontend** | _TODO — not deployed yet_ |
| **API** | _TODO — not deployed yet_ |
| **Database** | _TODO — not deployed yet_ |

Nothing in the repository is deployed at the time of writing. When it is, note that production
configuration is stricter than development by design:

- `JWT_SECRET` **must** be set, or the server refuses to start.
- `ALLOW_DEMO_SEED=true` is required for the demo seeder to run at all under `NODE_ENV=production`,
  and even then it insists on an explicit `DEMO_SEED_PASSWORD`.
- `COOKIE_SECURE` defaults to `true` in production, and `COOKIE_SAME_SITE` should stay `lax` when
  the client proxies `/api` on the same origin.

## API overview

The machine-readable contract is `server/openapi.yaml`, served at `GET /api/docs`. A unit test
statically parses the route files and fails if any mounted route is undocumented, so the YAML and
the code cannot drift.

| Area | Endpoints | Notes |
| ---- | --------- | ----- |
| **Health & docs** | `GET /api/health`, `GET /api/docs` | Public |
| **Auth** | `POST /api/auth/{register,login,logout}`, `GET /api/auth/me` | Session is an HttpOnly cookie; no token in any response body |
| **Reference data** | `GET /api/users`, `GET /api/location/{zones,service-points}` | Public; `GET /api/users` is unauthenticated so `/status` can list the seeded accounts |
| **Routing** | `POST /api/routes/estimate` | Auth required; pgRouting over directed edges |
| **Fares** | `POST /api/fare-quotes` | Passenger only; the price is chosen by the server |
| **Ride requests** | `POST /api/ride-requests`, `GET /api/ride-requests/my`, `GET /api/ride-requests/:id`, `POST /api/ride-requests/:id/cancel`, `GET /api/ride-requests/:id/fare` | Passenger only; needs an `Idempotency-Key`; cancellation is allowed only from `WAITING` |
| **Passenger reads** | `GET /api/passengers/me/current-ride`, `GET /api/passengers/me/rides[/:id]` | The ride DTO publishes `stage`, `nextAction` and `cancellable` |
| **Driver availability** | `GET`/`PATCH /api/drivers/me/availability` | Publishing `canGoOnline` / `canGoOffline` rather than leaving the rule to the client |
| **Driver offers** | `GET /api/drivers/me/offers`, `POST /api/drivers/me/offers/:id/{accept,reject}` | Reading offers doubles as the liveness heartbeat; accept takes no body |
| **Driver trip** | `GET /api/drivers/me/current-pool`, six `POST`s under `/api/drivers/me/pools/:poolId/…` | `allowedActions` is the list of buttons the UI may show |
| **Driver history** | `GET /api/drivers/me/rides[/:poolId]` | The pools that driver has driven |

Conventions that hold across the whole surface:

- **Ids come from the session.** Every `/me` path knows who is asking; nothing takes a user id.
- **A resource that is not yours is a 404**, never a 403 — a 403 would confirm the id exists.
- **Money is an exact decimal string**; instants are UTC ISO-8601 or `null`.
- **Lists return `{ data, pagination }`**; single resources return the object, optionally wrapped
  (`{ user }`, `{ ride }`, `{ pool }`).
- **Errors are `{ error: { message } }`**, always.

## Key decisions and trade-offs

**The database enforces the product.** Every guarantee has a `CHECK`, a trigger, a foreign key or
a partial unique index behind it, not merely a service-level check. *Trade-off:* schema changes
are more deliberate, and a rule cannot be relaxed without a migration — which is the point when
the rule is "one passenger cannot hold two active rides".

**Rules are code as data, in pure modules.** `ride.status.js`, `dispatch.rules.js`,
`matching.rules.js`, `pool-fare.rules.js` and `trip.rules.js` hold no I/O and are unit tested in
isolation; the services, the SQL and the tests all read from them. *Trade-off:* an extra layer of
indirection, repaid the first time a transition has to change in exactly one place.

**The server publishes what a client may do.** `allowedActions`, `nextAction`, `stage`,
`cancellable`, `canGoOnline` are all computed server-side. *Trade-off:* slightly larger DTOs;
in exchange a client cannot drift from the rules, and a stale screen fails with a clear 409 rather
than corrupting state.

**Money is exact decimal, never a float.** `Prisma.Decimal` and `numeric` columns throughout; a
JavaScript `number` is refused for money. *Trade-off:* more ceremony around arithmetic
(decimal.js-*light* has no `shiftedBy`), against never explaining a rounding error to a passenger.

**Timelines are append-only.** `ride_events` and `pool_events` refuse `UPDATE` by trigger, and an
event is written in the same transaction as the state change it records. *Trade-off:* a retry must
be idempotent so it does not write a second event — handled by deciding idempotency from state.

**Migrations are idempotent and cumulative.** All of `server/db/*.sql` re-runs on every
`db:migrate`, and a correction is appended as a convergence section rather than edited in place.
*Trade-off:* the files grow and carry some history; in exchange, any database can be brought to
the current schema by one command, in any state.

**A read is a projection, not a loop.** Prisma emits `query` events under `NODE_ENV=test`, and the
read suites assert that a page costs the same number of queries however many rows it returns.
*Trade-off:* some denormalisation in the summary selects, bought back as predictable latency.

**The client has no test suite.** `npm run lint` and `npm run build` are its automated checks; the
server's 1136 tests pin the contract it renders. *Trade-off:* accepted for a demo — it is the one
decision here I would revisit first.

## Known limitations

Honest list, including the ones that are deliberate:

- **No payment, wallet, refund or payout.** Fares are calculated and recorded, never charged.
- **No ratings, no notifications, no live GPS.** The client polls; the driver reports a service
  point, not a trail of coordinates.
- **No passenger cancellation once matched, and no driver-side cancellation** — the API refuses
  both. Cancelling is permitted only while a request is still `WAITING`.
- **Reserved states are defined but unused**: `NO_SHOW`, `SKIPPED`, and a cancelled pool all exist
  in the schema and the state machine, waiting for a milestone that needs them.
- **`GET /api/users` is public and unauthenticated**, kept that way so `/status` can list seeded
  accounts. It leaks the user list, and should be closed before any real deployment.
- **The cancellation reason is recorded but not shown back.** The ride-detail DTO does not publish
  `cancellationReason`, so the passenger's finished screen does not echo why.
- **The client is unverified by tests** (see above), and polling stands in for realtime.
- **The seeded graph is a small teaching fixture** — 45 points of Dhaka, not a real network.
- **The demo pricing is invented.** The rates in `server/src/db/seeds/fare.data.js` exist to make
  the pipeline demonstrable; they are not Dhaka taxi, rickshaw or ride-share tariffs, and must not
  be quoted as real prices.
- **No ADMIN account or workflow** — the role exists and is reserved, but nothing uses it.

## Next improvements

Ordered roughly by what I would do first:

1. **Authentication hardening for deployment** — close `GET /api/users`, add rate limiting on
   login, and rotate the cookie name per environment.
2. **Client tests** — at minimum a suite around the two state-rendering paths (`ride-status.js`,
   `driver-status.js`) and the polling hook, since those are where a client bug would be silent.
3. **Realtime transport** — replace polling with SSE or WebSockets, keeping the same DTOs so the
   screens do not change.
4. **Payment and settlement** — the fare calculation is already auditable to the share, so this
   becomes an integration rather than a redesign.
5. **Driver-side and matched-ride cancellation** — needs the reserved `CANCELLED` states, a
   cancellation policy, and a decision about who bears the cost.
6. **Notifications** — offer arrived, driver on the way, driver arrived.
7. **Ratings and trip history for passengers.**
8. **Operational schedulers** — the three `*:expire` / `*:sweep` commands exist as manual scripts;
   running them on a timer is the obvious next step.
9. **Merge Prisma drift** — the hand-maintained `schema.prisma` carries known, documented drift
   from the SQL (partial unique indexes are invisible to Prisma, and a few indexes are recreated
   without `DESC`).

## AI usage

<!-- EDIT SPACE: intentionally left blank — to be filled in by the author. -->

## Demo video

<!-- EDIT SPACE: replace with the real link when it exists. -->

_Demo video: TODO_

---

# Reference

The rest of this document is the detailed, milestone-by-milestone reference: every rule, every
constraint, and why each one is shaped the way it is. Read it when you want to know *why* rather
than *what*.

## Repository layout

```
TeslaB/
├── client/                 # Next.js 16 (App Router, JavaScript, Tailwind CSS v4)
│   ├── src/
│   │   ├── app/            # Routes, layouts, and pages
│   │   │   ├── layout.js
│   │   │   ├── page.js     # Home page; fetches from the Express API
│   │   │   └── globals.css
│   │   └── lib/
│   │       └── api.js      # fetch wrapper for the Express API
│   ├── public/             # Static assets
│   ├── next.config.mjs     # /api/* proxy rewrite -> Express
│   └── .env.local.example
├── server/                 # Express 5 API (ESM)
│   ├── db/                 # SQL applied by migrate / on first container boot
│   │   ├── 01-schema.sql
│   │   ├── 02-seed.sql
│   │   ├── 04-auth.sql                    # roles, profiles, vehicles
│   │   ├── 04-drop-transport-network.sql  # forward migration removing the old location model
│   │   ├── 05-postgis-location.sql        # PostGIS zones, points and routing graph
│   │   ├── 06-pgrouting-routing.sql       # pgRouting + the integer graph identifiers
│   │   ├── 07-fare-pricing.sql            # versioned fare policies + immutable quotes
│   │   └── 08-ride-requests.sql           # owned quotes, ride requests + append-only history
│   ├── prisma/
│   │   └── schema.prisma   # Prisma view of the SQL schema (hand-mapped)
│   ├── prisma7.config.ts   # Prisma CLI config (reuses src/config/env.js)
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── commands/       # Operational scripts (expire-ride-requests, dispatch-sweep)
│   │   ├── config/env.js   # Environment configuration
│   │   ├── db/             # Prisma client, health probe, migration runner, seeder
│   │   │   ├── seeds/      # location + routing graph + pricing + demo accounts, idempotent
│   │   │   └── seeds/graph-ids.js  # deterministic pgRouting identifiers (shared rule)
│   │   ├── routes/         # Route definitions (index, health, auth, users, location, routes, fare-quotes, ride-requests, drivers)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / queries (location, routing, fare, ride-request, ride.status, driver, dispatch, offer, pool)
│   │   ├── serializers/    # Record -> response DTO mappers
│   │   ├── middleware/     # notFound, errorHandler, auth (requireAuth, requireRole, requirePassengerProfileId, requireDriverProfileId)
│   │   └── utils/          # ApiError, validation, geo, time, password, token, cookies
│   ├── test/               # node --test suites (unit + integration)
│   └── .env.example
├── docker/
│   └── db/Dockerfile       # PostgreSQL 17 + PostGIS 3.5 + pgRouting
├── docker-compose.yml      # builds docker/db/Dockerfile, database "TeslaB"
├── .env.example            # Optional compose overrides
├── package.json            # npm workspaces + dev/build/db scripts
└── .gitignore
```

## Database

PostgreSQL 17 runs via `docker-compose.yml`:

| Setting         | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Database        | `TeslaB`                                              |
| User / password | `postgres` / `postgres`                             |
| Host port       | **`55432`** (container port 5432)               |
| Connection URL  | `postgres://postgres:postgres@localhost:55432/TeslaB` |

> **Why port 55432?** This machine already has a local PostgreSQL service on `5432` and another container on `5433`. Override with `POSTGRES_PORT` in a root `.env` (see `.env.example`) and update `DATABASE_URL` in `server/.env` to match.

### PostGIS and pgRouting prerequisites

The database image is built from `docker/db/Dockerfile`, which starts from **`postgis/postgis:17-3.5`** and adds the **`postgresql-17-pgrouting`** package. PostGIS is required because the location foundation stores real spatial types (`geography(Point, 4326)` and `geometry(LineString, 4326)`); pgRouting is required because the route endpoint hands the graph to `pgr_dijkstra`. Neither the plain `postgres` image (no PostGIS) nor the upstream `postgis/postgis` image (no pgRouting) can run this project as-is.

```bash
npm run db:up        # build docker/db/Dockerfile and start the container
npm run db:migrate   # 05-postgis-location.sql: CREATE EXTENSION postgis
                     # 06-pgrouting-routing.sql: CREATE EXTENSION pgrouting
```

- **Rebuilding after a Dockerfile change.** `docker compose up -d --build db` (which `npm run db:up` performs) rebuilds the image when needed and recreates the container. The `teslab-pgdata` volume is PostgreSQL 17 either way, so existing data survives and nothing needs migrating.
- **Our image, not the upstream one.** `docker compose ps` should show `teslab/postgis-pgrouting:17-3.5`. If it still shows `postgis/postgis:17-3.5`, the container predates this milestone -- recreate it: `docker compose up -d --force-recreate db`. Without pgRouting, the migration fails with `could not open extension control file`.
- **Privileges.** `CREATE EXTENSION` needs a role allowed to create extensions. The compose database runs as the superuser `postgres`, so this works out of the box; on a managed PostgreSQL service the extension is usually enabled from the provider's console (or by a superuser) instead, and the migration statement then becomes a no-op.
- **Building needs network access** to `apt.postgresql.org`, which is where the pgRouting package comes from.

Verify both extensions are present:

```sql
SELECT extname
FROM pg_extension
WHERE extname IN ('postgis', 'pgrouting');
```

```bash
npm run db:psql   # then paste the query
```

Expected: two rows, `postgis` and `pgrouting` (this project is built against PostGIS 3.5 and pgRouting 3.8).

### ORM (Prisma)

All database access goes through **Prisma**. `server/src/db/prisma.js` exports the single client, built on the official `@prisma/adapter-pg` driver adapter (which Prisma 7 requires for PostgreSQL). Services use Prisma models rather than hand-written SQL, and error handling maps both Prisma error codes (`P2002` → 409, `P2025` → 404) and the SQLSTATEs Prisma nests inside raw-SQL errors, so the 400/404/409 contract is unchanged.

The relationship between Prisma and the SQL files is deliberate:

- **`server/db/*.sql` remains the source of truth for the physical schema.** `server/prisma/schema.prisma` was produced by introspecting it (`prisma db pull`) and maps onto the existing snake_case tables and columns with `@@map`/`@map`, so renaming a Prisma model does not rename a table.
- **`prisma migrate` is intentionally not used.** Prisma does not model `CHECK` constraints or PostGIS types, so handing it ownership of migrations would try to drop constraints such as `routing_edges_no_self_loop` and the GiST spatial indexes. Migrations stay hand-written and are applied by `npm run db:migrate`, which executes each file through Prisma, one transaction per file.
- **Spatial columns are `Unsupported("geography")` / `Unsupported("geometry")` in the Prisma schema**, because Prisma has no PostGIS types. Reading or writing a coordinate therefore goes through parameterised raw SQL (`src/services/location.service.js`, `src/db/seeds/location.seed.js`), not the Prisma client.
- `DATABASE_URL` is resolved by `server/src/config/env.js` for both the API and the Prisma CLI (`prisma7.config.ts` imports that module), so the two cannot drift apart and the API still runs with no `.env` file at all.

To check that the Prisma view still matches the live database:

```bash
cd server
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

An empty migration is the ideal result. Three things will show up as intended differences, and none is drift to "fix":

1. the GiST spatial indexes, which Prisma cannot express on an `Unsupported` column, so it always proposes dropping them;
2. `ride_requests_passenger_requested_at_idx`, `dispatch_offers_request_idx` and `dispatch_offers_driver_offered_at_idx`, which are declared with a `DESC` sort (a passenger's history, and a request's or driver's offers, are read newest first). Prisma can express the columns but not the sort direction, so it proposes recreating each index without `DESC`. The indexes Prisma cannot see at all are the four **partial unique** ones -- `one_active_ride_request_per_passenger`, `one_pending_initial_offer_per_request`, `one_pending_initial_offer_per_driver` and `one_active_pool_per_driver` -- because Prisma does not model `WHERE` clauses on indexes. Those four are what decide this project's races, which is the second reason migrations stay hand-written;
3. any leftover object from a database that predates the current migration files -- for example a table created by a migration that has since been removed. The database in this workspace has some of these from an earlier, abandoned branch; `npm run db:reset` gives a clean database built only from the files in `server/db`.

Like `pg_typeof()`, a few PostgreSQL internals cannot be read through Prisma raw queries; cast them (`pg_typeof(x)::text`) when you need them.

Schema (`server/db/01-schema.sql`):

```sql
CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Postgres errors are translated to HTTP responses in `server/src/middleware/errorHandler.js` — e.g. a duplicate email (`23505`) becomes `409`.

### PostGIS location tables (`server/db/05-postgis-location.sql`)

| Table              | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `service_zones`    | The 15 Dhaka zones; unique `code` **and** unique `name`, `active`, `geography(Point, 4326)` centre |
| `service_points`   | Curated pickup/drop-off places; globally unique `code`, `geography(Point, 4326)` location, one zone and one routing vertex |
| `routing_vertices` | Graph nodes; unique `code`, `geometry(Point, 4326)` location                     |
| `routing_edges`    | Directed graph edges; `geometry(LineString, 4326)`, measured distance, normal/rush durations, fare weight |

Design notes:

- `code` is the stable seed key on every table, which is why a zone's display `name` can change without breaking anything that references it.
- `service_points.user_id`-style uniqueness: `(zone_id, name)` is unique, so a zone cannot list the same place twice, and `code` is globally unique.
- `service_points.routing_vertex_id` is `NOT NULL`, so a point can never exist without a graph node. The tables were created empty, so no two-phase backfill was needed.
- `routing_edges` rejects self-loops, requires at least two points of geometry, keeps `distance_meters` equal to `ST_Length(geometry::geography)`, requires `rush_hour >= normal`, and enforces that the reverse-duration columns are present **exactly** when `bidirectional` is true.
- GiST spatial indexes exist on all four geometry/geography columns; the graph also has indexes on source, target, active and code.
- `updated_at` is maintained by a shared `set_updated_at()` trigger; internal timestamps are never returned by the API.

> **Note on the coordinate range checks.** A `geography` value in SRID 4326 is *normalised* on input: casting an out-of-range point does not raise, it is silently corrected (latitude 95 becomes 85, longitude 190 becomes −170). The range checks on the geography columns therefore document what is stored rather than rejecting a bad input. Rejecting an out-of-range coordinate happens **before** the cast, in `server/src/utils/geo.js`. The range checks on `routing_vertices.location` (plain `geometry`, which does *not* normalise) are real and do fire. A test pins this behaviour.

## API

Base URL: `http://localhost:4000/api`

| Method   | Endpoint                     | Description                                                                          |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/health`                  | Service status, uptime, and database probe                                            |
| `GET`  | `/users`                   | List users                                                                            |
| `GET`  | `/users/:id`               | Get a single user (`404` if missing)                                                |
| `POST` | `/users`                   | Create a user (**ADMIN only**) — body: `{ "name", "email" }`                |
| `POST` | `/auth/register`           | Sign up as PASSENGER or DRIVER; signs in — body: `{ "name", "email", "password", "role"? }` |
| `POST` | `/auth/login`              | Log in; sets the HttpOnly auth cookie — body: `{ "email", "password" }`      |
| `GET`  | `/auth/me`                 | Current user (requires authentication)                                                |
| `POST` | `/auth/logout`             | Clear the auth cookie (safe to retry)                                                 |
| `GET`  | `/location/zones`          | List the 15 active service zones                                                      |
| `GET`  | `/location/points`         | List active service points, optional `?zoneCode=`                                   |
| `GET`  | `/location/points/:code`   | Get one service point by code                                                         |
| `POST` | `/routes/estimate`         | Estimate a route between two service points (**requires authentication**) -- see [Routing](#routing) |
| `POST` | `/fare-quotes`             | Quote a solo fare in BDT (**PASSENGER only**) -- see [Fare quotes](#fare-quotes) |
| `POST` | `/ride-requests`           | Ask for a ride from a quote the caller owns (**PASSENGER only**) -- see [Ride requests](#ride-requests) |
| `GET`  | `/ride-requests/my`        | The caller's own ride requests, newest first, paged (**PASSENGER only**) |
| `GET`  | `/ride-requests/:id`       | One of the caller's own ride requests (**PASSENGER only**) |
| `POST` | `/ride-requests/:id/cancel`| Cancel a request that is still waiting (**PASSENGER only**) |
| `GET`  | `/ride-requests/:id/fare`  | The caller's own shared fare (**PASSENGER only**) -- see [Shared fares](#shared-fares) |
| `GET`  | `/passengers/me/current-ride` | The passenger's active ride, with `stage` and `nextAction` (**PASSENGER only**) -- see [Reading a ride](#reading-a-ride) |
| `GET`  | `/passengers/me/rides`     | The passenger's ride history, filterable and paged (**PASSENGER only**) |
| `GET`  | `/passengers/me/rides/:rideRequestId` | One of the passenger's own rides, with its stops and timeline (**PASSENGER only**) |
| `GET`  | `/drivers/me/availability` | The driver's own availability (**DRIVER only**) -- see [Driver dispatch and pools](#driver-dispatch-and-pools) |
| `PATCH`| `/drivers/me/availability` | Go online or offline in one call: `{ online, servicePointCode \| servicePointId }` (**DRIVER only**) -- see [Reading a ride](#reading-a-ride) |
| `POST` | `/drivers/me/online`       | Go online at a service point (**DRIVER only**) |
| `POST` | `/drivers/me/offline`      | Go offline (**DRIVER only**) |
| `PUT`  | `/drivers/me/current-service-point` | Move to another service point (**DRIVER only**) |
| `GET`  | `/drivers/me/offers`       | The driver's own dispatch offers, of both kinds (**DRIVER only**) -- see [Pool-first shared matching](#pool-first-shared-matching) |
| `GET`  | `/drivers/me/offers/:offerId` | One of the driver's own offers (**DRIVER only**) |
| `POST` | `/drivers/me/offers/:offerId/accept` | Accept an offer (no body); starts a pool, or adds the passenger to an existing one (**DRIVER only**) |
| `POST` | `/drivers/me/offers/:offerId/reject` | Refuse an offer; the request moves on, the pool does not change (**DRIVER only**) |
| `GET`  | `/drivers/me/pool`         | The pool the driver is committed to (**DRIVER only**) -- see [The driver's trip](#the-drivers-trip) |
| `POST` | `/drivers/me/pools/:poolId/depart` | Set off for the first pickup: closes the pool to matching, freezes the fare (**DRIVER only**) |
| `POST` | `/drivers/me/pools/:poolId/stops/:stopId/arrive` | Reach the next stop (**DRIVER only**) |
| `POST` | `/drivers/me/pools/:poolId/stops/:stopId/members/:memberId/pickup` | Confirm a passenger is in the vehicle (**DRIVER only**) |
| `POST` | `/drivers/me/pools/:poolId/start` | Begin the journey with the passengers on board (**DRIVER only**) |
| `POST` | `/drivers/me/pools/:poolId/stops/:stopId/members/:memberId/dropoff` | Deliver a passenger (**DRIVER only**) |
| `POST` | `/drivers/me/pools/:poolId/complete` | Finish the trip and release the driver (**DRIVER only**) |
| `GET`  | `/drivers/me/rides`        | The pools the driver has driven, filterable and paged (**DRIVER only**) -- see [Reading a ride](#reading-a-ride) |
| `GET`  | `/drivers/me/rides/:poolId` | One of the driver's own pools, in detail (**DRIVER only**) |
| `GET`  | `/docs`                    | The OpenAPI 3.1 document, served verbatim from `server/openapi.yaml` |

**`server/openapi.yaml` is the machine-readable contract** for the whole API: paths, parameters, status codes, response DTOs and worked examples using the seeded Banani data and the demo cast. It is served at `GET /api/docs` as `text/yaml`, so an editor or a client generator can fetch it from the running API. `test/unit/openapi.test.js` checks it against the route files, so a route that is not documented fails the suite.

The location endpoints are read-only and return DTOs (`server/src/serializers/location.serializer.js`) instead of raw rows, so database column names, routing vertices and audit timestamps never leak into responses. `/location` is only ever about places: there is deliberately no route, distance, ETA, quote or fare endpoint under it, and none should be added. Route estimation lives at `/routes/estimate` instead.

Codes are stable machine-readable values (lower-case letters, digits, `-` and `_`). Input is trimmed and lower-cased, so `?zoneCode=BANANI` works.

```json
{
  "data": [
    { "id": "…", "code": "banani-road-11", "name": "Banani Road 11", "zoneCode": "banani", "latitude": 23.7937, "longitude": 90.4043 }
  ]
}
```

Status codes are consistent across the location endpoints:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `400`  | Missing, malformed or unsupported query parameter                        |
| `401`  | Credentials rejected, or no valid authentication (auth endpoints)        |
| `403`  | Authenticated, but not permitted for this role                           |
| `404`  | Unknown zone or point code                                               |
| `409`  | The record exists but is inactive (also used for database conflicts)    |
| `422`  | The request is well-formed but has no answer (an unreachable destination) |

Both calculation endpoints are authenticated, and neither is wrapped in a `data` envelope: a route estimate and a fare quote are the answer, not a list of answers. The location and ride-request-history endpoints return `{ "data": [...] }`.
`/health` reports `"ok"` when the database is reachable and `"degraded"` when it is not, and never fails the request:

```json
{
  "status": "ok",
  "uptime": 23.6,
  "timestamp": "2026-09-22T18:47:05.740Z",
  "database": { "status": "up", "latencyMs": 2 }
}
```

Errors use a consistent shape:

```json
{ "error": { "message": "User 99 not found" } }
```

## Authentication

Authentication is a **signed JWT carried in an HttpOnly cookie**. There is no server-side session store, and nothing is ever put in `localStorage`.

### Why this design

- The browser only ever talks to the same origin — `next.config.mjs` proxies `/api/*` to Express — so `SameSite=Lax` is sufficient and no CSRF token is needed.
- The cookie is `HttpOnly`, so JavaScript (and therefore any XSS payload) cannot read the token.
- The token payload carries **only the user id**. It deliberately never carries the role or the profile, because nothing in the token is trusted for authorization: `requireAuth` re-loads the user from the database on every request. A deactivated account, a deleted account or a changed role therefore takes effect on the very next request instead of at token expiry.

### Signing up

`POST /auth/register` creates an account and signs it in immediately, using the same HttpOnly cookie as login. It returns `201`.

| Field        | Required | Notes                                                                       |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `name`     | yes      | Trimmed; must not be blank                                                  |
| `email`    | yes      | The login identifier; trimmed and lower-cased before storage                |
| `password` | yes      | At least 8 characters, at most 72 bytes (bcrypt's input limit)              |
| `role`     | no       | `PASSENGER` (default) or `DRIVER`. **`ADMIN` is not accepted.** |

- A `PASSENGER` is created with a passenger profile; a `DRIVER` is created with a driver profile that starts `OFFLINE` and has no vehicle, so a self-registered driver cannot be matched until a vehicle exists.
- **`ADMIN` can never be self-selected.** It is not an accepted value for `role`, so a client cannot promote itself by adding a field to the body — the attempt is simply a `400`. Admins are created by an existing admin through `POST /api/users`.
- An email that is already registered returns `409`, including a case variant, because the identifier is normalised before it is stored.

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Ayesha","email":"ayesha@example.com","password":"BrandNewPass1!","role":"DRIVER"}' \
  http://localhost:4000/api/auth/register
```

> **Known trade-off.** Because sign-up reports that an email is already registered, this endpoint can be used to probe whether an account exists. Login deliberately does not leak that. The usual fix is to accept the request and confirm by email instead, which needs the email-verification flow that is not built yet (see Next steps).

### Demo accounts

Seeded by `npm run db:seed`. **Development/demo only — never seed these in production.**

| Actor  | Email                  | Role          | Profile / vehicle                         |
| ------ | ---------------------- | ------------- | ----------------------------------------- |
| Nusrat | `nusrat@example.com` | `PASSENGER` | Passenger profile                         |
| Rafiq  | `rafiq@example.com`  | `PASSENGER` | Passenger profile                         |
| Shirin | `shirin@example.com` | `PASSENGER` | Passenger profile                         |
| Jashim | `jashim@example.com` | `DRIVER`    | Driver profile + vehicle Bullet (3 seats) |

The demo password is **not** stored in the repository. Every demo account is given the value of `DEMO_SEED_PASSWORD` (default `DemoPass123!`), hashed with bcrypt before it reaches the database. To change it, set `DEMO_SEED_PASSWORD` in `server/.env` and re-run the seed.

> **Production warning.** The seeder refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`, and even then it requires `DEMO_SEED_PASSWORD` to be set explicitly. The server separately refuses to start in production without `JWT_SECRET`.

### Example requests

```bash
# Log in. The token is returned only as a Set-Cookie, never in the body.
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}' \
  http://localhost:4000/api/auth/login

# Current user
curl -b cookies.txt http://localhost:4000/api/auth/me

# Log out (safe to retry)
curl -i -b cookies.txt -X POST http://localhost:4000/api/auth/logout
```

Successful login and current-user responses:

```json
{
  "user": {
    "id": "…",
    "name": "Nusrat",
    "role": "PASSENGER",
    "active": true,
    "passengerProfile": { "id": "…" }
  }
}
```

Jashim's response carries `driverProfile` instead, including the active vehicle summary:

```json
{
  "user": {
    "id": "…",
    "name": "Jashim",
    "role": "DRIVER",
    "active": true,
    "driverProfile": {
      "id": "…",
      "status": "OFFLINE",
      "vehicles": [{ "id": "…", "name": "Bullet", "seatCapacity": 3 }]
    }
  }
}
```

Only the profile belonging to the role is returned: `passengerProfile` for a passenger, `driverProfile` for a driver, and neither for an admin. `passwordHash` and the audit timestamps are never part of the response — `server/src/serializers/user.serializer.js` builds its output as a whitelist, so a new column cannot leak by accident.

### Authentication errors

| Status  | Meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `400` | Missing or malformed credentials, or an unsupported body field |
| `401` | Credentials rejected, or no valid authentication               |
| `403` | Authenticated, but not permitted for this role                 |

Every rejected login returns the same `401` with the same message, so a caller cannot tell an unknown account from a wrong password. Validation errors never echo the submitted password.

### Authorization

`server/src/middleware/auth.js` is the reusable foundation:

- `requireAuth` — loads the user from the database and rejects inactive or deleted accounts.
- `requireRole('ADMIN')` — role guard; must be mounted after `requireAuth`.
- `currentUser(req)` — the authenticated user attached to the request.

`POST /api/users` is gated with `requireRole(Role.ADMIN)`. That is both a real use of the guard and what stops a client from choosing `ADMIN` when creating an account. `POST /api/routes/estimate` uses `requireAuth` on its own, because estimating a route needs a session but not a particular role. The read endpoints (`GET /api/users`, `GET /api/location/*`) are still public so the Next.js demo page keeps working; tightening them is a follow-up once the client can send the cookie.

Authorization is always decided on the server from the database record. Hiding routes in the front end is not authorization.

## How the client talks to the API

- The browser requests `/api/...` on the Next.js origin; `next.config.mjs` rewrites those calls to the Express server (`API_PROXY_TARGET`, default `http://localhost:4000`). No CORS round-trip needed in the browser.
- Server components use `API_URL` from `client/.env.local` because relative URLs cannot be fetched on the server.
- Direct cross-origin calls still work — the API sends `Access-Control-Allow-Origin` for `CLIENT_ORIGIN`.

## Location and routing graph demo data

```bash
npm run db:up        # PostgreSQL 17 + PostGIS 3.5
npm run db:migrate   # create/refresh the schema, including postgis (idempotent)
npm run db:seed      # apply the demo zones, points and routing graph (idempotent)
npm test             # unit + integration tests
```

After seeding you get **15 service zones, 45 service points, 45 routing vertices and 46 routing edges** (42 bidirectional, 4 one-way).

> **Every coordinate is approximate demo data, not verified navigation data.** The MVP deliberately has no maps, geocoding, routing APIs or live traffic. `server/src/db/seeds/location.data.js` holds hand-written, neighbourhood-level coordinates for each named Dhaka location, and each edge is a straight two-point LineString between the coordinates it connects -- plausible for a demo, not a road centreline. Edit that one file to review or change any of it, then re-run `npm run db:seed`.

### ServicePoint vs RoutingVertex

They are deliberately separate models:

- a **ServicePoint** is passenger-facing: a curated place someone can later be picked up from or dropped at. It belongs to exactly one zone and has a stable, globally unique `code`.
- a **RoutingVertex** is a graph node: what a future router walks between. It carries no passenger-facing meaning.

In this seed they are one-to-one, which keeps the graph easy to reason about; the separation is what will later allow several service points to share one junction. `ServicePoint.routingVertexId` is `NOT NULL`, so a point can never exist without a vertex.

### Coordinate conventions

- Everything is **WGS84 / SRID 4326**.
- **Longitude comes first** in every PostGIS constructor: `ST_MakePoint(longitude, latitude)`. Reversing them is not an error PostGIS reports -- it silently stores a point somewhere else on the planet. Nothing in this codebase builds spatial SQL by hand: `server/src/utils/geo.js` is the single place the order is decided, and it only accepts a named `{ latitude, longitude }` pair, so the two cannot be passed positionally by mistake.
- Coordinates are validated in the application **before** the cast: latitude within ±90, longitude within ±180, and -- for this seed -- inside the generous Dhaka box defined in `geo.js`.

### RoutingEdge: distance, direction and durations

| Column | Meaning |
| ------ | ------- |
| `distanceMeters` | Measured from the geometry with `ST_Length(geometry::geography)`. Never hand-written, and a `CHECK` keeps the two in step, so an edge cannot claim a length its shape does not have. |
| `normalDurationSeconds` | Derived from the measured distance at `DEMO_SPEED_KMH.normal` (a demo 24 km/h). |
| `rushHourDurationSeconds` | Same, at the demo 14 km/h. A `CHECK` enforces `rush_hour >= normal`, so rush hour can never come out faster. |
| `fareWeight` | A relative weight that scales the per-kilometre part of an edge's fare -- one edge, in both directions. **It is not a fare, and no money is stored on an edge.** Defaults to 1; the seed includes 1.5 and 0.75 examples. See [Edge fare weight](#edge-fare-weight). |

Direction rules:

- a directed edge always permits travel **source → target**;
- `bidirectional = true` adds the return leg, so the `reverse*DurationSeconds` columns **must** be present;
- `bidirectional = false` has no return leg, so those columns **must** be NULL.

One `CHECK` enforces both cases, and self-loop edges are rejected. The seed sets the reverse duration equal to the forward one, because a single geometry describes the pair; the columns exist so a later phase can encode genuinely asymmetric traffic.

### Graph validation

The seed validates before it commits and rolls the whole transaction back if anything is wrong, in this order: zones → vertices → points → edges → coordinate bounds → edge geometry and endpoints → graph connectivity.

Connectivity is checked with a recursive CTE: no isolated vertex, every zone touches another zone, and all vertices form one weakly connected component. That is a data-integrity check, **not** pathfinding -- the router is a separate concern, see [Routing](#routing).

To verify the stored graph yourself:

```bash
npm run test:integration --workspace server
```

### What is deliberately deferred

This phase stores and validates a graph, and the milestones since calculate routes over it, price them, take ride requests and dispatch them to a driver. What is deliberately **not** implemented is everything after a match: adding a second passenger to an existing pool, shared or discounted fares, detours and route insertion, trip operations (arrival, pickup, drop-off, completion), live GPS, payments, wallets, notifications and demand-based surge pricing. See [Routing](#routing), [Fare quotes](#fare-quotes), [Ride requests](#ride-requests) and [Driver dispatch and pools](#driver-dispatch-and-pools).

## Routing

Point-to-point route estimation between two seeded service points, using **pgRouting**'s `pgr_dijkstra` over the stored graph.

```bash
docker compose up -d --build db                      # image with PostGIS + pgRouting
npm run db:migrate                                   # 06-pgrouting-routing.sql
npm run db:seed                                      # the graph the router walks

# The endpoint requires a session, so sign in first and keep the cookie.
curl -s -c cookies.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}'

curl -s -b cookies.txt -X POST http://localhost:4000/api/routes/estimate \
  -H 'Content-Type: application/json' \
  -d '{"originServicePointCode":"banani-road-11","destinationServicePointCode":"mohakhali-bus-terminal","departureAt":"2026-09-24T08:41:00+06:00"}'
```

### Migration

`server/db/06-pgrouting-routing.sql` is a **forward migration**: it is applied by `npm run db:migrate` on top of the existing files and does not rewrite any of them. It:

1. runs `CREATE EXTENSION IF NOT EXISTS pgrouting`;
2. adds `routing_vertices.graph_node_id` and `routing_edges.graph_edge_id` (see below);
3. backfills them for a graph that was already seeded;
4. adds the uniqueness, positivity and immutability enforced on them.

### Database and container requirements

PostgreSQL 17 with **both** PostGIS 3.5 and pgRouting 3.8. The container is built from `docker/db/Dockerfile`; see [PostGIS and pgRouting prerequisites](#postgis-and-pgrouting-prerequisites) for the verification query and the privileges `CREATE EXTENSION` needs. A plain `postgres` image cannot run this project: the migration fails without the extension control file.

### Identifier strategy

pgRouting requires **integer** graph identifiers. This project keys its tables on UUIDs, so each vertex and edge carries an additional immutable identifier *alongside* its UUID primary key:

| Column | Type | Purpose |
| ------ | ---- | ------- |
| `routing_vertices.graph_node_id` | `bigint`, unique, non-null | `source` / `target` in pgRouting's edge query |
| `routing_edges.graph_edge_id` | `bigint`, unique, non-null | `id` in that query, and the value pgRouting returns in its `edge` column |

- **Nothing was replaced.** The UUID `id` remains the primary key and the target of every foreign key; `service_points.routing_vertex_id` still points at a UUID. The integers are internal and are never returned by the API -- a client refers to an edge by its stable `code`.
- **The values are deterministic.** Both the migration and the seeder rank codes ascending in byte order (`COLLATE "C"` in SQL, `Array#sort` in `server/src/db/seeds/graph-ids.js`). Because the rule is derived from the codes rather than from insertion order, a database built from scratch and one migrated from the location phase end up with **identical** identifiers. Two unit tests and an integration test pin that agreement.
- **They are immutable.** `prevent_graph_identifier_change()` rejects any `UPDATE` of either column. A route result is a list of edge identifiers, so an identifier that could be reassigned would silently repoint an existing route.
- **They are assigned automatically if you do not name one.** A sequence supplies the next value for a hand-written insert (a fixture, say), and both the migration and the seeder keep that sequence above the highest identifier in use.

### Endpoint

`POST /api/routes/estimate` — **requires authentication.**

The existing `requireAuth` guard is mounted on this route, so the request must carry the same HttpOnly auth cookie `POST /auth/login` / `POST /auth/register` issued:

- **No valid session is a `401`**, including a malformed, tampered or expired token, and an account that was deactivated or deleted after its token was issued. The guard re-loads the user from the database on every request, so the token alone is never enough.
- **Any active role may call it.** A passenger planning a trip and a driver checking a pickup are equally entitled to estimate a route, so there is no `requireRole` here.
- The caller's identity is **not an input to the calculation**: nothing is written, and the response is identical for every authenticated user.
- It is the only endpoint in this milestone that requires a session. The location reads (`/location/*`) stay public, and no new authentication mechanism was built — this reuses `server/src/middleware/auth.js`.

| Field | Required | Notes |
| ----- | -------- | ----- |
| `originServicePointCode` | yes | A `service_points.code`; trimmed and lower-cased |
| `destinationServicePointCode` | yes | A different `service_points.code` |
| `departureAt` | no | ISO 8601 **with an explicit offset**; defaults to now |

Request:

```json
{
  "originServicePointCode": "banani-road-11",
  "destinationServicePointCode": "mohakhali-bus-terminal",
  "departureAt": "2026-09-24T08:41:00+06:00"
}
```

Response `200`:

```json
{
  "origin": { "code": "banani-road-11", "name": "Banani Road 11" },
  "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
  "departureAt": "2026-09-24T02:41:00.000Z",
  "estimatedArrivalAt": "2026-09-24T02:50:29.000Z",
  "trafficProfile": "RUSH_HOUR",
  "distanceMeters": 2214,
  "distanceKilometers": 2.214,
  "durationSeconds": 569,
  "durationMinutes": 9,
  "geometry": {
    "type": "LineString",
    "coordinates": [[90.4043, 23.7937], [90.4006, 23.774]]
  },
  "legs": [
    {
      "sequence": 1,
      "edgeCode": "edge-mohakhali-bus-terminal-to-banani-road-11",
      "direction": "BACKWARD",
      "distanceMeters": 2214,
      "durationSeconds": 569
    }
  ]
}
```

That is a real response from the seeded demo graph, not an illustration. Every field is built by `server/src/serializers/route.serializer.js`, which is a whitelist -- no graph identifier, no audit timestamp and **no fare field** can leak into it.

Notes on the numbers:

- `distanceMeters` is the **sum of the traversed edges' measured distances**, rounded per edge. It is network distance along the graph, never a straight-line distance.
- `distanceKilometers` is the same number in kilometres, rounded to the metre; `durationMinutes` is `durationSeconds` rounded to a whole minute.
- `estimatedArrivalAt` is exactly `departureAt + durationSeconds`. Both timestamps are UTC ISO 8601.
- `legs` are in travel order (`sequence` 1, 2, ...), one per traversed edge, and `direction` says whether that edge was followed along its stored `source → target` (`FORWARD`) or against it (`BACKWARD`).
- `geometry` is a single GeoJSON `LineString` in travel order, in `[longitude, latitude]` (the GeoJSON convention, which happens to match PostGIS's). Edges traversed backwards have their geometry reversed, so the line reads as the journey was made. The legs are joined in path order rather than by asking PostGIS to merge an unordered set, which is why a route with backward legs is still one `LineString`.

### Traffic profiles

An edge carries a normal duration and a rush-hour duration. The endpoint picks **one** profile for the whole route:

| Profile | When | Cost used |
| ------- | ---- | --------- |
| `NORMAL` | outside the rush-hour windows | `normal_duration_seconds` forward, `reverse_normal_duration_seconds` backward |
| `RUSH_HOUR` | inside them | `rush_hour_duration_seconds` forward, `reverse_rush_hour_duration_seconds` backward |

- The windows are **configurable** with `RUSH_HOUR_WINDOWS` (see `server/.env.example`). The default is `07:30-10:30,16:30-20:00`.
- A window is **half-open**: the start minute is rush hour, the end minute is not. With the default, 07:29 is normal, 07:30 and 10:29 are rush hour, and 10:30 is normal again.
- A window whose end is not after its start **wraps past midnight**, so `22:00-02:00` works.
- A malformed value stops the process at start-up instead of quietly estimating every route with the wrong costs.
- **A client cannot choose a profile.** Sending `trafficProfile` in the body is a `400`, not a silent override; the profile is derived on the server from the departure instant.

#### Asia/Dhaka

- `departureAt` is an instant; the response always returns UTC. Asia/Dhaka is used for exactly one thing: deciding whether *that instant* is rush hour locally, via `Intl.DateTimeFormat` (not a hard-coded `+06:00`), so a zone rule change cannot silently produce wrong answers.
- Because the decision is made on the instant, `2026-09-24T08:41:00+06:00` and `2026-09-24T02:41:00Z` produce byte-identical responses.
- A timestamp **without an offset** (`2026-09-24T08:41`) is a `400`: it does not name an instant, and guessing the zone is how a rush-hour route gets estimated with normal costs.
- **Known limitation.** The profile is chosen once, from the departure instant, and applies to the whole journey. A trip that departs at 10:29 is estimated entirely with rush-hour costs even though it crosses 10:30, and time-dependent profile changes *during* a journey are not supported. Supporting them needs per-second cost functions and a time-dependent router.

### Directed and one-way edges

- An edge always permits travel `source → target`. `bidirectional = true` adds the return leg.
- For a one-way edge the edge query returns `reverse_cost = -1`, which is how pgRouting is told the edge is *not traversable* in reverse -- it is not merely expensive. The seed contains four one-way edges, and `farmgate → khamarbari` is the interesting one: it makes Khamarbari and Indira Road reachable but with no way back out, so `khamarbari → banani-road-11` is a legitimate **`422`**, not an error.
- A detour is preferred to an illegal reversal. `shapla-chattar → sadarghat` is one-way; the reverse journey (`sadarghat → shapla-chattar`) therefore routes the long way round via `jatrabari-intersection` instead of using the direct edge backwards. Two integration tests pin this: the returned route never contains the one-way edge traversed backwards, and enabling the reverse leg temporarily makes the router switch to the direct edge.
- Routing uses **duration** as cost. Distance and `fare_weight` are never used as a routing cost: the path is chosen on duration alone, which is exactly why a fare weight can change a price without changing a route. Pricing itself belongs to [Fare quotes](#fare-quotes), and the route responses carry no fare field.

### Errors

| Status | When |
| ------ | ---- |
| `400` | Missing origin/destination, malformed code, malformed or offset-less `departureAt`, identical origin and destination, unsupported body field |
| `401` | No valid session: no cookie, a malformed/tampered/expired token, or an account that is inactive or deleted |
| `404` | Either service point code is unknown |
| `409` | Either service point is inactive, or its routing vertex is |
| `422` | Both points are valid and active, but no route exists (the graph is only weakly connected) |
| `500` | The graph or pgRouting failed -- always a stable `Route calculation failed` message |

```json
{ "error": { "message": "Service point \"nowhere\" was not found" } }
```

No raw SQL, driver message or stack trace is ever returned: internal failures are logged server-side and replaced with one fixed message.

### Security

- The two ServicePoint codes are validated against the project's code format and **bound as parameters**; they are never concatenated into SQL.
- pgRouting takes its edge set as SQL *text*, which is the obvious injection surface here. Nothing is interpolated into it: `server/src/services/routing.service.js` holds two complete, fixed, application-controlled edge queries -- one per profile -- and picks between them. Even the profile name never reaches the SQL, which is why a client cannot influence it.
- Graph identifiers are never accepted from a client. The identifiers passed to `pgr_dijkstra` come from the database (via the service points) and from pgRouting's own output, and are re-validated as positive integers.
- The endpoint **requires authentication** via the existing `requireAuth` middleware, which re-loads the active user from the database rather than trusting the token. Any active role may call it. Authentication runs *before* the body is validated, so an anonymous caller cannot probe the request contract, and the guard is mounted on the route rather than on the router, so an unknown `/api/routes/*` path still answers `404` instead of revealing that something is behind a guard. No new authentication system was built.
- The routing queries run with a PostgreSQL `statement_timeout` (default 5 s, `ROUTING_STATEMENT_TIMEOUT_MS`) scoped to a short transaction, so a runaway query cannot hold a connection indefinitely.

### Performance

The demo graph is tiny, but the shape is what a larger one would need: only **active** edges (and vertices) are considered; the path's edges are loaded in **one** query and put back into path order using the sequence pgRouting returned, so there is never a query per leg; and the unique index on each graph identifier is what that lookup uses, while `source_vertex_id`, `target_vertex_id` and `active` keep their indexes from `05-postgis-location.sql`. No caching is added: nothing has been measured yet.

### Approximate demo data

**Every coordinate, distance and duration in this graph is approximate demo data, not verified navigation data.** Edges are straight two-point lines between neighbourhood-level coordinates, and durations are derived from those lengths at demo speeds (24 km/h normal, 14 km/h rush hour). The route the endpoint returns is therefore a plausible-looking answer over a hand-written toy graph -- not a road-following route, and not a travel-time promise. There are no maps, no geocoding and no external routing or live-traffic APIs anywhere in this milestone.

### Routing tests

```bash
npm test                                   # everything (unit + integration)
npm run test:unit --workspace server        # no database needed
npm run test:integration --workspace server # needs `npm run db:up`
```

The routing coverage is deliberately explicit about the parts that are easy to get quietly wrong: that pgRouting is installed and callable; that the endpoint requires a session (401 without a cookie, with a tampered one, and for an account deactivated after its token was issued) while any active role is answered; the identifier strategy (UUID keys kept, integers added, the seeder's rule matching the database's, immutability enforced); Banani Road 11 → Mohakhali Bus Terminal; legs in path order and consecutive legs connected at a shared node; forward traversal using the forward duration and backward traversal using the reverse duration; a one-way edge refusing reverse traversal, and the detour that replaces it; network distance and duration equalling the sum over traversed edges only; rush-hour versus normal costs, both from fixed instants rather than the clock; arrival = departure + duration; geometry in path order, reversed for backward legs; every documented error case; and that no fare, request, pool or matching table or endpoint appeared.

## Fare quotes

Solo fare quoting: **how much** the journey from [Routing](#routing) costs, in **BDT**, under a **versioned** pricing policy, stored as an **immutable** quote.

```bash
docker compose up -d --build db                # PostGIS + pgRouting image
npm run db:migrate                             # 07-fare-pricing.sql
npm run db:seed                                # the demo policy (dhaka-solo v1)

# Authenticated, like route estimation: sign in first.
curl -s -c cookies.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}'

curl -s -b cookies.txt -X POST http://localhost:4000/api/fare-quotes \
  -H 'Content-Type: application/json' \
  -d '{"originServicePointCode":"banani-road-11","destinationServicePointCode":"mohakhali-bus-terminal","departureAt":"2026-09-24T08:41:00+06:00"}'
```

### Money: exact decimals, never floats

- **Storage** is PostgreSQL `numeric` everywhere (`fare_policies` at `numeric(12,4)`, `fare_quotes` at `numeric(14,6)`). There is no `float`/`double precision` column anywhere near a price, because binary floating point cannot represent `0.10` and a fare built from it is a fare nobody can reproduce.
- **Arithmetic** is decimal.js, reached through `Prisma.Decimal`, which the project already depends on via Prisma -- no new dependency was added. Every value is a `Decimal` or a decimal *string*; a JavaScript `number` is **refused** by the calculator rather than converted, because by the time a price is a `number` the precision is already gone.
- **Transport** is decimal **strings**: `"166.28"`, `"1.10"`, `"2.214"`. `JSON.parse` of a bare `166.28` produces a float, so returning numbers would undo the exactness at the last step. A client that needs to add or compare these should parse them as decimals.
- The seed file writes money as strings too (`baseFare: '40.00'`), so what the seed says is literally what the database stores.

### The fare formula

```text
edgeDistanceKilometers = edgeDistanceMeters / 1000
edgeDistanceCharge     = edgeDistanceKilometers × perKilometerRate × edgeFareWeight   [rounded]

distanceFare           = sum(edgeDistanceCharge)
timeFare               = (durationSeconds / 60) × perMinuteRate                       [rounded]
preTrafficSubtotal     = baseFare + distanceFare + timeFare
trafficMultiplier      = RUSH_HOUR ? rushHourMultiplier : normalTrafficMultiplier
trafficAdjustment      = preTrafficSubtotal × (trafficMultiplier - 1)                 [rounded]
unroundedFare          = max(minimumFare, preTrafficSubtotal + trafficAdjustment)
finalFare              = round(unroundedFare / fareRoundingUnit) × fareRoundingUnit   [snapped]
fareRoundingAdjustment = finalFare - unroundedFare
```

Every input comes from the server: the legs, distance and duration from the routing service, the policy from the database. A client cannot send a distance, a duration, a fare weight, a traffic profile or a policy version -- each of those is a `400` (see [the request](#fare-quote-request)).

### Rounding

There are two roundings, and they are different in kind. The first is arithmetic; the second is the price.

**Arithmetic: HALF_UP to the policy's `roundingScale`** (2 decimals by default). It happens at exactly two kinds of boundary, both marked `[rounded]` above:

1. when a money figure is produced -- each edge's distance charge, the time fare, and the traffic adjustment;
2. when a configured **amount** enters the calculation -- `baseFare` and `minimumFare` are expressed at `roundingScale`.

Nothing else is rounded at that scale and nothing is rounded twice. **Rates are not rounded**: a rate is a price per unit, not an amount, so it keeps its configured precision. The result is the property that makes a quote checkable -- every component is an amount at `roundingScale`, so *the displayed components always add up to the displayed fare*, and the database enforces it (`fare_quotes_subtotal_consistent`, `fare_quotes_total_consistent`).

**Price: a charged fare is a whole number of taka.** The very last step takes the protected fare -- after the minimum fare and after the traffic multiplier -- and snaps it to the nearest whole multiple of the policy's `fareRoundingUnit` (`10` in the demo). Nobody hands over sixty-three poisha, so nobody is asked for it, and the difference is written down rather than left as a gap:

```text
130.63  ->  130     fareRoundingAdjustment = -0.63    (rounded down)
126.00  ->  130     fareRoundingAdjustment = +4.00    (rounded up)
```

The adjustment is **signed**, unlike a cap reduction, because rounding goes whichever way is nearer; its magnitude is never more than half a unit. Both figures are in the response, so a client can show the arithmetic instead of a breakdown that mysteriously does not add up.

**Only the charged fare is snapped.** The components that explain it keep `roundingScale`, which is what keeps the per-edge audit trail reproducible: snapping each edge's `59.78` to `60` would corrupt the breakdown to make the total look rounder. A fare is therefore a whole number while its components are not, and the API presents it that way -- `"130"`, not `"130.00"`.

One consequence worth knowing before it surprises you: at a 10 taka granularity a small saving can be invisible. The reference journey's pooled fare of `126.63` rounds *up* to `130`, and the solo `130.63` rounds *down* to `130`, so the two read the same even though sharing really did cost less before the snap. Rounding never breaks a promise -- a passenger cannot be charged above their quote or above their previous fare, because both of those are whole numbers of units themselves -- but it can round a discount away. See [the cap-proof note](#the-rounding-unit-and-the-caps) for why that is guaranteed rather than hoped for.

Note that `durationMinutes` is a **presentation** value (2 decimals). The time fare is calculated from the exact duration, so `569 s` costs `569/60 × 2.00 = 18.9666… → 18.97`, not `9.48 × 2.00 = 18.96`.

### Fare-policy fields

| Field | Meaning |
| ----- | ------- |
| `code`, `version` | The identity of a policy version. Unique together. `dhaka-solo` v1 is the seeded demo policy. |
| `name` | Human label. |
| `currency` | `BDT`, and only BDT: a database constraint and the calculator both refuse anything else. |
| `baseFare` | Flat charge for any journey. Added once. |
| `perKilometerRate` | BDT per network kilometre, applied per edge. |
| `perMinuteRate` | BDT per routed minute. |
| `minimumFare` | Floor for the final fare. |
| `normalTrafficMultiplier` | Traffic multiplier outside the rush-hour windows. `1.0000` in the seed, so off-peak is the baseline. |
| `rushHourMultiplier` | Traffic multiplier inside them. `1.1000` in the seed. |
| `quoteTtlSeconds` | How long a quote stays usable: `expiresAt = createdAt + quoteTtlSeconds`. |
| `roundingScale` | Decimal places every money *component* is rounded to, `0`-`6`. |
| `fareRoundingUnit` | The unit a *charged* fare is rounded to: a whole number of at least 1, `10` in the seed, so every fare is a multiple of ten taka. It must divide `minimumFare`. |
| `active` | Whether the version may be selected at all. |
| `effectiveFrom` / `effectiveTo` | The window the version prices. Half-open: `effectiveTo` is nullable for an open-ended policy. |

All monetary rates must be non-negative, multipliers must be positive, the TTL must be positive, the scale must be 0-6, the rounding unit must be a whole number of at least 1, and the window must end after it starts -- each enforced by a `CHECK` constraint, not by a code path remembering to check.

### Pricing versioning

- A policy is identified by **`(code, version)`**. `dhaka-solo` v1 and v2 are different prices, not a correction to one price.
- **The version is chosen by the server**, from configuration (`FARE_PRICING_CODE`, default `dhaka-solo`) and the departure instant -- never from the request. The one documented rule is: *the highest version of the configured code that is `active` and whose window contains `departureAt`* (`effectiveFrom <= departureAt`, and `effectiveTo` is null or `> departureAt`). Departure, not creation, because the price that applies is the one for the journey being quoted.
- The window is **half-open**, so the usual upgrade is: give v2 a later `effectiveFrom` and set v1's `effectiveTo` to the same instant. There is then no gap and no overlap at the handover.
- **A version that has been quoted is frozen.** A trigger refuses any `UPDATE` of `code`, `version`, `currency`, the four amounts, either multiplier, `roundingScale` or `fareRoundingUnit` on a policy that quotes reference. Changing a live price means inserting the next version. Operational fields -- `name`, `active`, `effectiveFrom/To`, `quoteTtlSeconds` -- stay editable, because retiring or renaming a version changes no historical number.
- **The seeder never rewrites history.** It creates a version that does not exist, updates one that no quote references (so iterating on demo rates before anybody is quoted works), and leaves a quoted version completely alone.
- A departure instant with **no** effective policy, or with **more than one** (an overlapping configuration), is a server-side configuration failure: a controlled `500`, never a fallback rate. There is deliberately no default rate to substitute.

### Edge fare weight

`routing_edges.fare_weight` (seeded at 1.0, with 1.5 and 0.75 examples) multiplies the **distance charge** of the edge it belongs to. It is not an amount and not a rate: it scales the per-kilometre component of that one edge.

- It affects the **distance fare only** -- never the time fare, never the base fare, never the minimum fare.
- It **cannot change which route is taken**. The router optimises duration; fare weight is read after the path is chosen. An integration test sets a weight to 999 and asserts the route is byte-identical while the fare rises.
- A missing, zero, negative or non-finite weight is a **graph-data error**: a controlled `500`, never a silent default of 1.0, because quietly pricing an unweighted edge is how a fare becomes wrong without anyone noticing.
- One weight applies to the edge in both directions; directional weights are not implemented.

### Traffic multipliers

The route's traffic profile (`NORMAL` or `RUSH_HOUR`, decided server-side from the departure instant in Asia/Dhaka -- see [Traffic profiles](#traffic-profiles)) selects the multiplier, and it is applied **exactly once**, as a recorded adjustment on top of the subtotal:

```text
trafficAdjustment = round(preTrafficSubtotal × (multiplier - 1))
unroundedFare     = max(minimumFare, preTrafficSubtotal + trafficAdjustment)
```

It is never applied to the subtotal a second time and never to an already-adjusted total. `quoteTtlSeconds` is not a multiplier, and there is no demand-based surge pricing: the only traffic adjustment is this one.

### Minimum fare

`unroundedFare = max(minimumFare, adjustedSubtotal)`. The floor is applied **last**, after the traffic multiplier, and the quote records both the floor that applied and whether it actually won:

- `minimumFareApplied` is `true` only when the floor was *above* the calculated fare. A fare exactly equal to the minimum is the calculated fare, not a floor being imposed.
- The components are still stored when the floor applies, so the quote still explains what the journey actually cost to compute.
- `minimumFare` must be a whole number of the policy's `fareRoundingUnit`, and that is what makes the floor survive the rounding: if the fare before rounding is at least the minimum, and the minimum is itself a whole number of units, then the nearest multiple of the unit is at least the minimum too. A minimum of `85` with a unit of `10` would let an `86` fare round down to `80`, so the database refuses the policy instead.

<a id="the-rounding-unit-and-the-caps"></a>
### The rounding unit and the caps

The same argument protects both caps a pooled fare has to respect, and it is worth stating because a rounding step is exactly the kind of change that can quietly break a guarantee.

Every fare this project writes is a whole number of units, so `acceptedSoloFare` (the quote the passenger accepted) and `previousPooledFareCap` (what they were charged by the previous pool version) both are. Given that:

> if the cap is a multiple of `u`, and the fare before rounding is at most the cap, then the nearest multiple of `u` is at most the cap -- because if it were more it would be at least `cap + u`, and the fare would then have to be at least `cap + u/2`, which is above the cap.

So rounding can move a fare **up to** a cap and never past one. `passenger_fare_allocations_caps_are_whole_units` makes the premise a fact about the data rather than a habit of the service, and `passenger_fare_allocations_solo_cap_holds` / `passenger_fare_allocations_no_increase_holds` state the conclusion.

### Quote expiration

- `expiresAt = createdAt + quoteTtlSeconds`, both timestamps derived from one instant, so the difference is exactly the TTL (`300 s` in the seed) with no drift between two clocks.
- **Expiry does not delete anything.** An expired quote stays stored: it is evidence of what was offered, and a later `RideRequest` will need to point at it. Nothing in this phase prunes quotes, and the table has an index on `expires_at` for a future sweep.
- Expiry is a deadline a consumer must respect. `isQuoteExpired(quote, at)` in `server/src/services/fare.calculator.js` is the one definition, and a quote is expired **at** its expiry instant.

### FareQuote: immutable and auditable

A quote is written once and never updated -- a trigger refuses any `UPDATE`, and no service function exists that could try. It records:

- the two service points (as foreign keys), the departure and estimated arrival instants, the traffic profile, the distance and duration the fare was calculated over;
- the **exact policy version** used, by id and by `pricingCode`/`pricingVersion`, plus the currency;
- every component of the formula: `baseFare`, `distanceFare`, `timeFare`, `preTrafficSubtotal`, `trafficMultiplier`, `trafficAdjustment`, `minimumFare`, `minimumFareApplied`, `unroundedFare`, `fareRoundingAdjustment`, `finalFare`;
- a **`routeSnapshot`**: the ordered legs with their edge code, traversal direction, distance, selected duration, fare weight and the distance charge that weight produced, plus the merged geometry and the endpoints. This is the audit trail, stored rather than recomputed later against a graph that may since have changed;
- a **`fareBreakdown`**: the components, the rates that produced them, the quantities they were applied to, and the rounding rule (`{ scale, mode, unit }`).

Because the breakdown is stored with the quote, a quote stays reproducible after its policy is superseded -- and the stored arithmetic is self-checking: three `CHECK` constraints refuse a row whose subtotal, total or minimum-fare flag does not agree with its own numbers.

### Fare-quote request

`POST /api/fare-quotes` — **requires authentication and the `PASSENGER` role**. A quote belongs to the passenger who asked for it: ownership is what stops one passenger accepting another passenger's quote with a ride request, and it arrived with the ride-request milestone. A driver is refused with `403` rather than served a quote nobody could accept.

| Field | Required | Notes |
| ----- | -------- | ----- |
| `originServicePointCode` | yes | A `service_points.code`; trimmed and lower-cased |
| `destinationServicePointCode` | yes | A different `service_points.code` |
| `departureAt` | no | ISO 8601 **with an explicit offset**; defaults to now. Decides both the traffic profile and which policy version applies |

Sending anything else -- `distanceMeters`, `durationSeconds`, `finalFare`, `pricingVersion`, `pricingCode`, `trafficMultiplier`, `currency` -- is a `400`, not a silently ignored field. There is no field that names a passenger: the owner is taken from the session, and the response never says who it is.

### Fare-quote response

`201 Created`: a quote is a stored resource with an id, like a created account.

```json
{
  "quoteId": "cc1116ae-0a82-4d4c-9d06-92d8084c26e4",
  "origin": { "code": "banani-road-11", "name": "Banani Road 11" },
  "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
  "departureAt": "2026-09-24T02:41:00.000Z",
  "estimatedArrivalAt": "2026-09-24T02:50:29.000Z",
  "trafficProfile": "RUSH_HOUR",
  "route": {
    "distanceMeters": 2214,
    "distanceKilometers": "2.214",
    "durationSeconds": 569,
    "durationMinutes": "9.48"
  },
  "fare": {
    "currency": "BDT",
    "pricingCode": "dhaka-solo",
    "pricingVersion": 1,
    "baseFare": "40.00",
    "distanceFare": "59.78",
    "timeFare": "18.97",
    "preTrafficSubtotal": "118.75",
    "trafficMultiplier": "1.10",
    "trafficAdjustment": "11.88",
    "minimumFareApplied": false,
    "unroundedFare": "130.63",
    "fareRoundingAdjustment": "-0.63",
    "finalFare": "130"
  },
  "expiresAt": "2026-09-24T02:46:00.000Z"
}
```

That is a real response from the seeded demo graph. Check it by hand: the traversed edge is 2214 m and weighted 1.5, so `2.214 × 18.00 × 1.5 = 59.778 → 59.78`; the rush-hour duration is 569 s, so `569/60 × 2.00 = 18.9666… → 18.97`; the subtotal is `40.00 + 59.78 + 18.97 = 118.75`; the peak adjustment is `118.75 × 0.10 = 11.875 → 11.88`; the fare before rounding is `40.00 + 59.78 + 18.97 + 11.88 = 130.63`; and the nearest whole 10 taka to that is `130`, so the charge is `130` and the adjustment is `-0.63`. The same journey at 12:00 costs `110`, because the duration drops to 332 s and the multiplier is `1.00` (`110.85` before the rounding).

Error responses use the project's standard shape:

```json
{ "error": { "message": "Unsupported body field(s): finalFare. Supported: originServicePointCode, destinationServicePointCode, departureAt" } }
```

| Status | When |
| ------ | ---- |
| `201` | A quote was created and stored |
| `400` | Missing origin/destination, malformed code, malformed or offset-less `departureAt`, identical endpoints, unsupported body field |
| `401` | No valid session |
| `404` | Either service point code is unknown |
| `409` | Either service point is inactive, or its routing vertex is |
| `422` | No route exists between two valid, active points |
| `500` | The routing algorithm, the policy configuration, the fare calculation or the quote write failed -- always a stable message, never raw SQL or a pricing dump |

### Commands

```bash
npm run db:migrate                 # applies 07-fare-pricing.sql (idempotent)
npm run db:seed                    # seeds the demo policy; safe to re-run
npm test                           # unit + integration
npm run test:unit --workspace server        # calculator and serializer, no database
npm run test:integration --workspace server # endpoint, policy data, quotes (needs the database)
```

The fare tests are explicit about the parts that are easy to get quietly wrong: that the policy seed is idempotent and creates no duplicate version; that `(code, version)` is unique; that a quoted version cannot be re-priced, renamed rates aside; that the correct version is selected for an instant, and that a missing or overlapping configuration is a controlled failure; that money is exact decimal and that a JavaScript `number` is refused; that the base fare is included once; that the per-kilometre fare uses network edge distances and the per-minute fare the routed duration; that fare weight scales the distance fare and cannot change the route; that the multiplier is applied once; that the minimum fare is enforced and recorded; that rounding is deterministic and happens at the documented boundaries; that a stored quote references its policy version and carries an auditable snapshot whose charges add up; that it cannot be modified or reached by any update path; that expiry is exactly the TTL and never deletes; that invalid weights, missing policies and unreachable routes are controlled errors; and that a client cannot influence any of it.

### Demo pricing disclaimer

**Every rate in `server/src/db/seeds/fare.data.js` is invented demo configuration, not official transport pricing.** The values (`40.00` base, `18.00`/km, `2.00`/min, `80.00` minimum, `1.10` peak multiplier) exist to make the pricing pipeline demonstrable and testable. They are not Dhaka taxi, rickshaw, ride-share or regulatory rates, and nothing here should be quoted to anybody as a real price. The seeder also refuses to run in production unless `ALLOW_DEMO_SEED=true`, exactly like the demo accounts.

### What is deliberately not here

Fare *quoting* stops at a price. There is no pooling discount, seat reservation, payment, wallet, demand-based surge pricing or external pricing API -- and no external routing API. A quote is a **solo** fare: one journey, one passenger, one price.

What a passenger in a shared car actually owes is a separate calculation, built on these quotes rather than a replacement for them: see [Shared fares](#shared-fares). Every passenger keeps their solo quote as a ceiling, and the pooling arithmetic never re-prices it.

A quote **is** owned by the passenger who asked for it -- ownership arrived with the ride-request milestone, which is what stops one passenger accepting another passenger's quote. The ride request that accepts it is the next section.

## Ride requests

A ride request is one passenger asking for one ride from one quote they own. It is the first endpoint in this project that creates something a passenger can come back and find, so most of its design is about identity, ownership and what happens when a client retries.

```bash
# 1. Quote the journey (the caller owns the quote).
curl -i -X POST http://localhost:4000/api/fare-quotes \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"originServicePointCode":"banani-road-11","destinationServicePointCode":"mohakhali-bus-terminal","departureAt":"2026-09-24T08:41:00+06:00"}'

# 2. Ask for the ride, naming the quote and an idempotency key.
curl -i -X POST http://localhost:4000/api/ride-requests \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: ride-2026-09-24-0001' \
  -b cookies.txt -d '{"fareQuoteId":"cc1116ae-0a82-4d4c-9d06-92d8084c26e4"}'
```

### One passenger, one journey, no seats

A request is **one passenger** travelling from one pickup point to one destination point. There is no seat count, no requested-seats field and no per-seat fare anywhere -- not in the request table, not in the DTO, and not in the lifecycle module. Capacity planning for a future pool counts *assigned passenger requests*, which is why the model has none of those fields to migrate away from later.

### Statuses and transitions

| Status | Meaning | Active? |
| ------ | ------- | ------- |
| `WAITING` | Requested, looking for a ride | yes |
| `MATCHED` | A pool has been matched (future milestone) | yes |
| `IN_PROGRESS` | The ride is under way (future milestone) | yes |
| `COMPLETED` | The ride finished (future milestone) | no -- terminal |
| `CANCELLED` | The passenger cancelled while waiting | no -- terminal |
| `EXPIRED` | The search window closed with nobody matched | no -- terminal |

```mermaid
stateDiagram-v2
    [*] --> WAITING
    WAITING --> CANCELLED: passenger cancels (implemented)
    WAITING --> EXPIRED: search window closes (implemented)
    WAITING --> MATCHED: matching (reserved)
    MATCHED --> IN_PROGRESS: trip starts (reserved)
    MATCHED --> CANCELLED: cancel a matched ride (reserved)
    IN_PROGRESS --> COMPLETED: trip ends (reserved)
    COMPLETED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
```

**Implemented in this milestone:** `WAITING -> CANCELLED`, `WAITING -> EXPIRED` and `WAITING -> MATCHED`, which a driver accepting a dispatch offer performs (see [Driver dispatch and pools](#driver-dispatch-and-pools)). **Reserved:** the trip transitions. The database trigger already allows every transition in the diagram, so the trip milestone needs no migration -- but nothing in the API can reach a reserved one, and `IMPLEMENTED_TRANSITIONS` in `server/src/services/ride.status.js` is what says so. Terminal statuses are terminal: they have no outgoing transition at all, reserved or otherwise.

The rules live in one place, `server/src/services/ride.status.js`, with no database access, and three things share them: the service, the `enforce_ride_request_update()` trigger in `08-ride-requests.sql`, and the tests.

### Status, money and identity are frozen

`ride_requests` is written once and then only moves along the table above. A trigger refuses an `UPDATE` of the passenger, the quote, either endpoint, `requested_at`, the idempotency key, the fingerprint or any of the five accepted amounts; the service is the only writer of `status`, `cancelled_at` and `cancellation_reason`, in the same transaction as the event that records the change.

The accepted fare is a **copy**, not a join: `accepted_fare`, `currency`, `accepted_pricing_code`, `accepted_pricing_version`, `accepted_distance_meters` and `accepted_duration_seconds` are columns on the request. Combined with the quote's own immutability, there is no path by which a later repricing could change what a passenger agreed to.

### Append-only history

Every lifecycle step appends a `ride_events` row in the same transaction as the change it describes, so a status can never exist without the history that explains it:

| Column | Meaning |
| ------ | ------- |
| `sequence` | 1, 2, 3... per request, unique per request, taken under the request's row lock |
| `event_type` | `RIDE_REQUESTED`, `RIDE_CANCELLED`, `RIDE_EXPIRED`, `DRIVER_OFFERED`, `DRIVER_REJECTED`, `DRIVER_OFFER_EXPIRED`, `DRIVER_OFFER_CANCELLED`, `DRIVER_ACCEPTED`, `PASSENGER_MATCHED` (the match), plus reserved trip events |
| `actor_type` / `actor_user_id` | `PASSENGER`, `SYSTEM` or `ADMIN`; null for a `SYSTEM` event, and `SET NULL` if the account is later deleted |
| `previous_status` / `new_status` | What the request moved from and to -- null `previous_status` for creation |
| `metadata` | A JSON object: the quote id on creation, the reason on cancellation, the deadline on expiry. Never a person, a token or client free text |

`UPDATE` on an event is refused by a trigger; `DELETE` is allowed only so that a cascading account deletion (and a future retention job) can work. No endpoint exposes history: it is recorded for audit, and this milestone has no read model for it.

### Idempotency

`POST /api/ride-requests` requires an `Idempotency-Key` header -- 8-128 characters of `A-Z a-z 0-9 . _ : -`, a shape pinned in both the validator and a `CHECK` constraint.

- A retry with the **same key, same passenger and same quote** returns the request that already exists, as `200` with the same body. It never creates a second request.
- The same key sent with a **different** request is a `409`, because one key cannot mean two things.
- The key is scoped to the passenger: two passengers may use the same string.
- "The same request" is decided by a **fingerprint**, a SHA-256 of the canonical inputs (passenger, quote, endpoints, accepted fare, currency, price version, distance, duration), computed server-side and stored. A client can neither send one nor influence it, and it is never returned.
- Two callers racing with the same key and the same quote both get the request: one created it (`201`), the other replayed it (`200`). This is the case the quote lock and the re-read in `createRideRequest` exist for.

A key is spent once it has created a request. Cancelling the request does not free the key -- a retry after a cancellation returns the cancelled request, which is what a network retry actually wants.

### One active request at a time

A passenger may have at most one request that is `WAITING`, `MATCHED` or `IN_PROGRESS`. It is enforced by a partial unique index (`one_active_ride_request_per_passenger`) rather than by a check the service performs, so a race cannot get two through:

```sql
CREATE UNIQUE INDEX one_active_ride_request_per_passenger
  ON ride_requests (passenger_profile_id)
  WHERE status IN ('WAITING', 'MATCHED', 'IN_PROGRESS');
```

The service checks first and answers `409`, but the index is the guard: when the check loses a race, the insert fails and the service re-reads the committed state to work out which of the three constraints was hit and report *that*, rather than a generic conflict. The rule inherits into matching for free -- a passenger with a matched ride already cannot start a second one.

### Quote ownership

`POST /api/fare-quotes` now requires the `PASSENGER` role, and the quote records the passenger profile that asked for it. A request may only be created from a quote the caller owns:

- somebody else's quote is a `404`, the same answer as a quote that does not exist, so this cannot be used to discover quotes;
- a quote with **no** owner (written before this milestone) is refused too, and logged, because it belongs to nobody and could never be safely claimed;
- one quote is accepted **once** (`fare_quotes` is referenced `ON DELETE RESTRICT` from a unique column), so a spent quote cannot be re-used under a fresh key;
- an expired quote is a `409` telling the caller to ask for a new one, and a quote whose endpoint has since been deactivated is a `409` as well.

### Search window and expiration

Creating a request opens a search window: `search_expires_at = requested_at + RIDE_REQUEST_SEARCH_TTL_SECONDS` (600 s by default). A `CHECK` constraint refuses a window that is empty or inverted, so a request can never be born already expired.

There is no scheduler in this project, so expiration is an **operation** rather than a background job:

```bash
npm run ride-requests:expire --workspace server
```

`expireOverdueRideRequests()` finds `WAITING` requests whose window has closed and expires each one in its own transaction, taking the request's row lock and re-checking the state before it writes. A request that was cancelled in the meantime is skipped rather than failed -- the sweep reports `{ examined, expired, skipped }`. Expiry appends a `RIDE_EXPIRED` event with the `SYSTEM` actor, leaves `cancelled_at` untouched (an expiry is not a cancellation) and never deletes the row. It is idempotent, and it frees the passenger's active slot. The clock is injectable, which is what makes all of it testable without waiting for a deadline.

### Cancelling

`POST /api/ride-requests/:id/cancel` cancels a **WAITING** request only -- cancelling a matched ride means releasing a pool, which needs the trip milestone. The body is optional:

| Field | Required | Notes |
| ----- | -------- | ----- |
| `reason` | no | `CHANGED_MIND`, `WRONG_LOCATION`, `WAIT_TOO_LONG` or `OTHER` (default) |

`CANCELLED` implies both `cancelled_at` and `cancellation_reason`, and no other status may carry either -- a `CHECK` constraint, not a convention. A second cancellation is a `409`, cancelling somebody else's request is a `404`, and a request that already expired is a `409`.

### Ride-request request and response

`POST /api/ride-requests` accepts **only** `fareQuoteId`, and requires the `Idempotency-Key` header. Everything else a client might expect to send -- `passengerId`, `status`, `fare`, `currency`, `distanceMeters`, `durationSeconds`, `pricingCode`, `pricingVersion`, `requestFingerprint` -- is an unsupported body field and a `400`, because all of it is derived server-side from the authenticated passenger and the quote. There is no field anywhere that names a passenger.

`201 Created` for a new request, `200` when a retry replayed one:

```json
{
  "id": "0f8b2a1e-9f31-4a0e-9f3c-1e6f2b0d4c77",
  "status": "WAITING",
  "cancellable": true,
  "pickup": { "code": "banani-road-11", "name": "Banani Road 11" },
  "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
  "acceptedQuote": {
    "fareQuoteId": "cc1116ae-0a82-4d4c-9d06-92d8084c26e4",
    "fare": "130",
    "currency": "BDT",
    "pricingCode": "dhaka-solo",
    "pricingVersion": 1,
    "distanceMeters": 2214,
    "durationSeconds": 569
  },
  "requestedAt": "2026-09-24T02:41:30.000Z",
  "searchExpiresAt": "2026-09-24T02:51:30.000Z",
  "cancelledAt": null,
  "cancellationReason": null
}
```

`cancellable` is derived from the status rather than stored, so it cannot disagree with it. `fare` is an exact decimal string, formatted at the quote's own rounding scale. The response never contains the fingerprint, the idempotency key, the passenger profile, the route snapshot, the quote's breakdown or any rate card.

| Status | When |
| ------ | ---- |
| `201` | A request was created |
| `200` | A retry returned the request that already existed |
| `400` | Missing/malformed `fareQuoteId`, missing or malformed `Idempotency-Key`, unsupported body field, unknown `status` filter, out-of-bounds `limit`/`offset` |
| `401` | No valid session |
| `403` | Authenticated, but not a passenger (or a passenger with no profile) |
| `404` | Unknown, expired-away, or somebody else's quote or request |
| `409` | Already used quote, expired quote, deactivated endpoint, second active request, key reused for a different request, cancellation from a status that cannot be cancelled |
| `500` | An unexpected failure -- always a stable message, never raw SQL |

### Passenger history

`GET /api/ride-requests/my` returns the caller's own requests, newest first, with a `pagination` block. `?status=` filters by any of the six statuses, `?limit=` (1-100, default 20) and `?offset=` page through them. The passenger filter is part of every query, so no page can contain somebody else's request, and an unknown query parameter is a `400` rather than being ignored.

```json
{
  "data": [ { "id": "...", "status": "CANCELLED", "cancellable": false, "cancellationReason": "WAIT_TOO_LONG", "...": "..." } ],
  "pagination": { "limit": 20, "offset": 0, "returned": 1, "total": 1, "hasMore": false }
}
```

Ordering is `requested_at DESC, id DESC`: two requests created in the same millisecond still have one stable order.

### Authorization

Every ride-request endpoint requires the `PASSENGER` role, and the passenger is taken from the authenticated record -- never from the request. A driver gets `403` (not `404`: the endpoint exists, they are simply not allowed to use it), an anonymous caller gets `401`, and another passenger's request is a `404` whether it exists or not.

### Commands

```bash
npm run db:migrate                                  # applies 08-ride-requests.sql (idempotent)
npm run ride-requests:expire --workspace server      # expire requests whose window has closed
npm test                                             # unit + integration
npm run test:unit --workspace server                 # lifecycle rules and serializer, no database
npm run test:integration --workspace server          # the endpoints, the constraints, concurrency, expiry
```

### What is deliberately not here

There is **no** shared fare, pooling discount, seat reservation, payment, wallet, live tracking or notification -- and no endpoint that changes a status other than cancellation and expiry, apart from the match a driver's acceptance performs. `IN_PROGRESS` and `COMPLETED` are defined, enforced and tested at the database level so the trip milestone needs no migration, but nothing in this API can move a request into them, and the `MATCHED -> CANCELLED` and trip transitions are reserved rather than implemented.

A `WAITING` request with a pending dispatch offer is cancelled together with that offer, in one transaction -- see [Passenger cancellation](#passenger-cancellation).

One consequence worth stating plainly: because `ride_requests.fare_quote_id` is `ON DELETE RESTRICT`, deleting a passenger profile that still has requests is refused by the database. Nothing in the application deletes either, and a future erasure path has to delete requests before profiles. A matched request is `RESTRICT`ed by its pool member in the same way.


## Driver dispatch and pools

A waiting ride request is offered to one driver at a time, and the driver who accepts it gets a pool.

```
Passenger creates a WAITING RideRequest
  -> the dispatcher shortlists nearby AVAILABLE drivers (PostGIS)
  -> and routes each one to the pickup (pgRouting)
  -> the best candidate gets a DispatchOffer that expires
  -> the driver accepts  ->  RidePool + PoolMember + 2 PoolStops, request MATCHED, driver RESERVED
  -> or refuses        ->  the request stays WAITING and the next driver is offered it
  -> or never answers  ->  the offer expires and the next driver is offered it
```

```bash
# The driver reports where they are and goes online.
curl -i -X POST http://localhost:4000/api/drivers/me/online \
  -H 'Content-Type: application/json' -b driver-cookies.txt \
  -d '{"currentServicePointCode":"banani-kakoli"}'

# What they can see and answer.
curl -s -b driver-cookies.txt http://localhost:4000/api/drivers/me/offers
curl -i -X POST http://localhost:4000/api/drivers/me/offers/<offerId>/accept -b driver-cookies.txt
curl -i -X POST http://localhost:4000/api/drivers/me/offers/<offerId>/reject \
  -H 'Content-Type: application/json' -b driver-cookies.txt -d '{"reason":"TOO_FAR"}'

# The dispatcher, for a scheduler to run.
npm run dispatch:sweep --workspace server
```

### Driver availability

One field is authoritative: `driver_profiles.status`. It already existed as `OFFLINE | AVAILABLE | ON_RIDE`; this milestone adds `RESERVED` rather than a second, competing availability column.

| Status | Meaning | Dispatched to? |
| ------ | ------- | -------------- |
| `OFFLINE` | Not accepting offers | no |
| `AVAILABLE` | May receive an initial ride offer | **yes** |
| `RESERVED` | Accepted a pool; the trip has not started | no |
| `ON_RIDE` | Operating a trip (a later milestone) | no |

Alongside it, `driver_profiles` records the dispatcher's inputs: `current_service_point_id` (nullable while offline), `available_since`, `last_seen_at`, and `active_vehicle_id`.

| Endpoint | What it does |
| -------- | ------------ |
| `GET /api/drivers/me/availability` | The driver's own state, plus the vehicles they may choose from |
| `POST /api/drivers/me/online` | `{ currentServicePointCode, vehicleId? }` - becomes `AVAILABLE` at that point |
| `POST /api/drivers/me/offline` | Becomes `OFFLINE`; idempotent |
| `PUT /api/drivers/me/current-service-point` | `{ currentServicePointCode }` - moves, and refreshes `last_seen_at` |
| `GET /api/drivers/me/offers` | The driver's own offers, of both kinds: `INITIAL_RIDE` (start a ride) and `ADD_PASSENGER` (change the pool they are already committed to). Pending by default, `?status=ALL` for history |
| `GET /api/drivers/me/offers/:offerId` | One offer, if it is theirs -- a join offer includes the proposed stop order, `currentStops` and the capacity it would use |
| `POST /api/drivers/me/offers/:offerId/accept` | Accept. Takes **no body**: the plan is the one that was offered. Starts a pool, or adds the passenger to the pool in one transaction |
| `POST /api/drivers/me/offers/:offerId/reject` | `{ reason? }` from `TOO_FAR`, `UNAVAILABLE`, `VEHICLE_ISSUE`, `OTHER`. The pool is left exactly as it was, and the request is passed to the next candidate |
| `GET /api/drivers/me/pool` | The pool they are committed to, or null |

Going online requires all four of: an active driver profile, an active vehicle **with positive capacity**, an active service point, and a status that may become available. A driver with several usable vehicles must say which one (`vehicleId`), and one is never picked for them; if they went online before, the vehicle they used is reused. A vehicle belonging to somebody else is a `404`.

Going offline is idempotent, because a retried "go offline" that already succeeded is not an error. A `RESERVED` or `ON_RIDE` driver cannot go offline or move through these endpoints at all -- they are committed to a passenger, and releasing that is an operator decision, not a device one.

A database `CHECK` (`driver_profiles_available_has_location`) makes `AVAILABLE` impossible without a point and an `available_since`, so a half-available driver cannot exist.

### The current ServicePoint model

For this MVP the driver reports which **seeded service point** they are nearest. There is no continuous GPS, no coordinate column on the driver, and no interpolation: the dispatcher needs to know which place to route from, and a service point is a place the router already knows.

`last_seen_at` is refreshed when a driver goes online, moves, reads their offers, or answers one -- the moments we learn they are still there. A location older than `DISPATCH_LOCATION_FRESHNESS_SECONDS` (default 300 s) makes the driver **ineligible**, because a location we cannot trust is not one we can promise a passenger.

### Driver relevance

A driver is a candidate only when **all** of these hold. The first group is answered in SQL, in one query, so the candidate list *is* the eligible list; the last one needs the router and is stage 2.

- the user is an active `DRIVER` with an active `DriverProfile`;
- availability is `AVAILABLE`;
- `current_service_point_id` is set and that point is active;
- `last_seen_at` is inside the freshness window;
- `active_vehicle_id` is set, and that vehicle is active with capacity > 0;
- the driver has no active `RidePool` (`FORMING`, `DRIVER_EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`);
- the driver has no other `PENDING` initial offer;
- the driver has not already had this request and failed to take it -- a refusal **or** an unanswered offer that expired;
- the shortlist radius reaches them, and the routed approach is inside the maximum.

### Two-stage search

**Stage 1 - spatial shortlist.** `ST_DWithin(driver_point.location, pickup.location, radius)` on the geography columns, with `DISPATCH_SHORTLIST_RADIUS_METERS` (default 3000 m) and a ceiling of `DISPATCH_MAX_RADIUS_METERS` (8000 m) for a widened search. At most `DISPATCH_MAX_CANDIDATES` (20) drivers are shortlisted, nearest first. The GiST index on `service_points.location` is the access path.

**Stage 2 - routing validation.** Every shortlisted driver is routed from their current point to the pickup. A driver the router cannot reach is dropped -- and so is one whose `approachDurationSeconds` exceeds `DISPATCH_MAX_APPROACH_SECONDS` (default 900 s). A driver already standing at the pickup is the shortest possible approach: distance and duration are `0`, and the offer says so.

The seeded graph shows why both stages are needed. Gulshan 2 Circle is 1068 m from the Banani Road 11 pickup in a straight line but **3120 m and 802 s** by road; Banani Kakoli is 445 m / 114 s; Mirpur-10 is 3911 m straight-line and 7097 m / 1825 s by road. Proximity decides who is worth routing; the router decides who is near.

### Scoring and tie-breaking

The offer goes to the single best candidate, ranked by a deterministic score in **seconds**:

```text
score = approachDurationSeconds
      + rejectionPenaltySeconds    x refusals in the last rejectionWindow
      + workloadPenaltySeconds     x acceptances in the last workloadWindow
      - min(idleCreditMaxSeconds, floor(idleSeconds / 60) x idleCreditPerMinuteSeconds)
      (never below 0)
```

It reads as "this many seconds away, adjusted for how this driver has behaved and how long they have been waiting". Every weight is configuration (`DISPATCH_*` in `.env.example`), all in seconds, so dispatch can be tuned without touching the ranking logic -- and a test can zero the penalties to isolate proximity. The idle credit is **capped** so a driver idle for a week cannot outrank one who is two minutes away: fairness nudges the choice, it does not override proximity. The straight-line distance the shortlist used is deliberately not in the score.

Ties break, in order: **lowest score**, then **longest idle** (earliest `available_since`), then **driver profile id**. The third key is what makes dispatch reproducible -- the same situation always produces the same offer -- and it is unit-tested on the same set in both orders.

Candidate scores are stored on the offer (`score`) so a decision can be explained afterwards, and are **never** returned to the driver.

### Sequential offers

One request is offered to **one** driver at a time. Two partial unique indexes make that a database fact rather than a service convention:

```sql
CREATE UNIQUE INDEX one_pending_initial_offer_per_request
  ON dispatch_offers (ride_request_id)  WHERE status = 'PENDING' AND offer_type = 'INITIAL_RIDE';
CREATE UNIQUE INDEX one_pending_initial_offer_per_driver
  ON dispatch_offers (driver_profile_id) WHERE status = 'PENDING' AND offer_type = 'INITIAL_RIDE';
```

The first is why a request cannot be shopped to several drivers at once; the second is why one driver cannot be considering two passengers. `ADD_PASSENGER` exists as an offer type so the pooling milestone does not have to alter an enum in use, but this milestone creates `INITIAL_RIDE` offers and nothing else.

### Dispatch triggering

After `POST /api/ride-requests` commits, the controller calls `dispatchWaitingRequest` **outside** that transaction and swallows any failure: a request with no offer is still a valid request, and dispatch never gets to fail a passenger's ride. Awaiting it (rather than firing and forgetting) means the caller learns whether the ride was offered, and a test does not have to race it.

Dispatch is **idempotent**: a request that is not `WAITING`, already has a pending offer, already has a pool member, or whose search window has closed is *skipped*, not failed. Running it three times, or twice at once, produces one offer and one controlled skip.

Nothing keeps a promise that dispatch always runs, so `npm run dispatch:sweep --workspace server` is the operation that makes dispatch *eventually* correct as well as immediately correct: it expires overdue offers, re-offers the requests that lost one, and picks up requests that are waiting with nobody looking at them. Both sweeps are safe to run concurrently.

### Offer expiration

An offer lives for `DISPATCH_OFFER_TTL_SECONDS` (default **30**), stored as `expires_at = offered_at + ttl` on the row; a `CHECK` refuses a window that is not positive. There is no timer in the API process -- expiry is an operation, and `now` is injectable, which is what makes it testable without waiting.

Expiring an offer, in one transaction: lock the ride request, lock the offer, re-check that it is still `PENDING` and past its deadline, move it to `EXPIRED` with a `responded_at`, and append a `DRIVER_OFFER_EXPIRED` event. After the commit the request is offered to the next best driver. Answering an offer that has already expired is a `409`, and the answer *records the expiry* rather than pretending the driver refused -- two different facts, and the passenger's timeline should say which happened.

### Rejecting

A refusal ends the offer and nothing else. In one transaction: confirm it is this driver's `PENDING`, unexpired offer, set `REJECTED` with `respondedAt` and the normalised reason, and append a `DRIVER_REJECTED` event. It must **not** cancel the request, move it off `WAITING`, create a pool or reserve the driver -- and the tests assert each of those. After the commit the request goes to the next eligible driver.

`CANCELLED` never carries a reason and `REJECTED` always does (`dispatch_offers_response_consistent`), so a refusal with no reason is refused by the database, not quietly stored.

### The pool

| Table | What it holds |
| ----- | ------------- |
| `ride_pools` | One driver, one vehicle, one active trip. `status`, `capacitySnapshot`, `plannedRouteGeometry`, `plannedDistanceMeters`, `plannedDurationSeconds`, `version`, and the lifecycle timestamps |
| `pool_members` | One passenger. `rideRequestId` is **UNIQUE**: a request can join at most one pool. No contact data is copied |
| `pool_stops` | The ordered plan. `sequence` unique per pool, `(member, stop_type)` unique: exactly one pickup and one drop-off per member |
| `pool_events` | Append-only history, numbered per pool, like `ride_events` |

```mermaid
erDiagram
    RidePool ||--o{ PoolMember : "has"
    RidePool ||--o{ PoolStop : "orders"
    RidePool ||--o{ PoolEvent : "records"
    PoolMember ||--|| RideRequest : "is the same journey as"
    PoolMember ||--o{ PoolStop : "has"
    ServicePoint ||--o{ PoolStop : "is where"
    DriverProfile ||--o{ RidePool : "drives"
    Vehicle ||--o{ RidePool : "is driven"
```

Pool statuses are `FORMING | DRIVER_EN_ROUTE | ARRIVED | IN_PROGRESS | COMPLETED | CANCELLED`; this milestone creates only `FORMING`. A fourth partial unique index covers all four active statuses, so the trip milestones inherit the one-pool-per-driver rule without another migration:

```sql
CREATE UNIQUE INDEX one_active_pool_per_driver
  ON ride_pools (driver_profile_id)
  WHERE status IN ('FORMING', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS');
```

`capacitySnapshot` is a **copy** of the accepted vehicle's capacity, so a later capacity change cannot rewrite the pool that was planned with it. The plan comes from the quote the passenger accepted -- `planned_route_geometry` is the stored `routeSnapshot.geometry`, written through parameterised SQL because Prisma has no PostGIS types. `version` is there so a later milestone can add optimistic concurrency without a migration.

A trigger (`enforce_pool_stop_consistency`) refuses a stop that is not the request's own pickup or destination, a stop whose member belongs to another pool or request, and a drop-off placed before its pickup -- none of which a `CHECK` can express, because each reads other rows.

### The acceptance transaction

Acceptance is the largest write in the project, and it is **one transaction**: a half-matched ride cannot exist. In order:

1. lock the ride request, then the offer (that lock order is load-bearing -- see below);
2. confirm the offer is this driver's, `PENDING` and unexpired, expiring it and reporting `409` if it is not;
3. confirm the request is still `WAITING` and has no pool member;
4. lock the driver profile, and confirm they are still `AVAILABLE`, their point is still active, and it is still **the point the approach was measured from**;
5. lock the vehicle, and confirm it is active with capacity, and still the vehicle that was offered;
6. confirm the driver has no other active pool;
7. create the pool (`FORMING`, capacity copied by snapshot) and write the planned route geometry;
8. create the member (`ASSIGNED`) and the two stops -- sequence 1 the pickup at the request's pickup point, sequence 2 the drop-off at its destination, with planned arrivals derived from the approach and the passenger's own journey;
9. move the request `WAITING -> MATCHED` (through the one function allowed to change a ride request's status) and append `PASSENGER_MATCHED`;
10. move the driver to `RESERVED` and clear `available_since`;
11. mark the offer `ACCEPTED` with `respondedAt` and `ridePoolId`;
12. append `DRIVER_ACCEPTED` and the three pool events, then commit.

The route is **not** recomputed. Re-routing inside the transaction would add a pgRouting call to the critical section, and the passenger already agreed to the journey in the quote the request froze -- so acceptance verifies the driver has not moved away from the point the approach came from, and otherwise reuses it.

### Concurrency protections

Application checks alone cannot decide a race, so every rule that two writers could break is also a constraint. The services check too, for good error messages.

| Race | What settles it |
| ---- | --------------- |
| Two drivers accepting one request | the request's row lock plus `pool_members.ride_request_id` UNIQUE |
| One driver accepting two offers | `driver_profiles` row lock plus `one_active_pool_per_driver` |
| One driver offered two rides | `one_pending_offer_per_driver` (was `one_pending_initial_offer_per_driver` until shared matching widened it) |
| One request offered twice | `one_pending_offer_per_request` |
| Accepting after expiry | the offer is re-read under its lock and the deadline re-checked |
| Acceptance vs passenger cancellation | the ride request's row lock, taken **first** by both |
| Acceptance vs vehicle deactivation | the vehicle's row lock, re-read before the pool is written |
| Duplicate members, stop sequences | `UNIQUE (ride_request_id)`, `UNIQUE (ride_pool_id, sequence)`, `UNIQUE (pool_member_id, stop_type)` |
| Answering a refused offer | a terminal offer is final (trigger) |

**The lock order is the design.** Every path that touches both a ride request and its offers takes the *ride request's* lock first and the offer's second. Acceptance and cancellation both want the same two rows, so they must want them in the same order; whoever gets the request first decides the outcome, and the other one sees it. Without that rule, `accept` (offer then request) and `cancel` (request then offer) would deadlock.

The concurrency tests assert an invariant rather than a winner: after a cancellation racing an acceptance, the request is either `MATCHED` with exactly one pool, member and two stops, or `CANCELLED` with none of them -- and whichever it is, no offer is left `PENDING` for a driver to act on.

### Passenger cancellation

Cancelling a `WAITING` request with a pending offer cancels the offer **in the same transaction**, under the request's row lock, and appends `DRIVER_OFFER_CANCELLED`. The driver stays `AVAILABLE`: a ride that went away is not their fault. Because acceptance takes the same lock first, it either wins outright or sees `CANCELLED` -- never both, and never a pool for a cancelled ride.

### Commands

```bash
npm run db:migrate                                 # applies 09-driver-dispatch.sql (idempotent)
npm run dispatch:sweep --workspace server           # expire offers, re-offer waiting requests
npm test                                            # unit + integration
npm run test:unit --workspace server                # rules and serializers, no database
npm run test:integration --workspace server         # availability, dispatch, pools, constraints, races
```

The dispatch tests are explicit about the parts that are easy to get quietly wrong: that only an `AVAILABLE` driver with a usable vehicle, a fresh location and an active point is considered; that the spatial radius is a shortlist and the routed approach is the answer; that an unreachable driver is excluded even when they are the nearest on the map; that ordering is reproducible; that a request gets one offer and a driver holds one; that a refusal or an expiry leaves the request `WAITING` and passes it on without ever going back to the driver who did not take it; that acceptance produces exactly one pool, one member, two ordered stops, the status changes and both timelines; that every guard at acceptance time rolls the whole thing back; and that the races resolve one way or the other but never both.

### What is deliberately not here

There is **no** shared fare or pooling discount, and no trip operations at all -- no driver arrival, trip start, passenger pickup, drop-off or completion. No live GPS, no WebSockets and no notifications. Everything about *matching a second passenger into a pool* is in the [next section](#pool-first-shared-matching); what is still missing is what happens once the car is moving, and what sharing is worth in money. The schema, the enums and the constraints are already shaped for the trip: `ride_pool_status` and `pool_stop_status` carry the states, `driver_status.RESERVED` exists, and the active-pool index already covers an in-progress pool.

Two operational notes: the sweep is a command nobody calls yet, so an expired offer is cleaned up when something runs it; and because `dispatch_offers.vehicle_id` and `ride_pools.vehicle_id` are `ON DELETE RESTRICT`, a vehicle that appears in dispatch history cannot be deleted while that history exists.


## Pool-first shared matching

A second passenger in a car that is already going that way is cheaper for everybody than a second car -- so every new `WAITING` request now tries to join a ride that is already forming **before** it is offered a driver of its own.

```text
search compatible existing pools
  -> one ADD_PASSENGER offer for the best pool
  -> the pool's driver accepts or refuses
  -> acceptance adds the passenger to the pool
  -> a refusal (or an expiry) tries the next compatible pool
  -> when no pool will take them, fall back to initial driver dispatch
```

The passenger stays `WAITING` for the whole attempt. Offering is not assigning: a pending offer changes nothing, a refusal changes nothing, and an expired offer changes nothing -- which is what keeps `cancellable` honest until a driver says yes.

```bash
# The whole flow, over HTTP: the pool is created by an accepted initial offer...
curl -X POST localhost:3001/api/ride-requests -H 'content-type: application/json' \
  -H "cookie: $PASSENGER" -d '{"fareQuoteId":"...","idempotencyKey":"..."}'
# ...and a later compatible request is folded into it. The driver sees this
# instead of a new ride, and answers it:
curl localhost:3001/api/drivers/me/offers -H "cookie: $DRIVER"
curl -X POST localhost:3001/api/drivers/me/offers/$OFFER_ID/accept -H "cookie: $DRIVER"
```

### The assignment orchestrator

`assignWaitingRequest(rideRequestId)` in `src/services/assignment.service.js` is the one entry point, and it is idempotent by construction:

1. load the request; stop unless it is `WAITING`, unless its search window is still open, unless it has no pool member, and unless it has no pending offer **of either kind** (an initial offer is never created while a pool is considering a join, and vice versa);
2. while inside `MATCHING_WINDOW_SECONDS` of the request, shortlist and evaluate existing pools, and offer the best plan;
3. otherwise -- or when no pool can take them -- call the existing `dispatchWaitingRequest` for a driver of their own.

The fallback is the *same* `RideRequest`, still `WAITING`, and no pool is created while an offer is pending. Nothing about a failed join -- a refusal, an expiry, a stale plan -- can move a request to `MATCHED`; only an accepted offer can, in one transaction.

Re-running it (or the sweeper, or three callers at once) produces one offer and one controlled skip, because the offer inserts are guarded by partial unique indexes and a losing insert is reported as a skip rather than as an error.

### Eligible pools: `FORMING` only

A pool whose driver is on the way, arrived or driving is a commitment to the passengers already in it, and a new stop cannot be inserted into a car that is already elsewhere. So `ELIGIBLE_POOL_STATUSES` is exactly `['FORMING']`, and the rest is a database filter rather than a service check, so the candidate list *is* the eligible list:

| The pool | The driver | The request |
| -------- | ---------- | ----------- |
| `status = 'FORMING'` | account active, profile `RESERVED` for this pool | not already a member of it |
| has a planned route geometry | still at a service point, which is where the approach is measured from | this driver has not already refused, or let an offer for it expire |
| member count `< capacitySnapshot` | vehicle active, capacity > 0 | -- |
| every stop still `PENDING` | -- | -- |
| no route change already pending | -- | -- |

### The PostGIS prefilter

Stage one is one query. The new pickup -- and optionally the new destination -- must be near the pool's *planned route*, not near its driver:

```sql
ST_DWithin(pickup.location, rp.planned_route_geometry::geography, $3::float8)
```

`ride_pools_planned_route_geometry_idx` (GiST) makes it a spatial lookup, and two managed indexes keep the rest of the filter cheap: `ride_pools_forming_idx` and the partial `one_pending_route_change_offer_per_pool`. The radius is configuration (`MATCHING_RADIUS_METERS`, default **1500 m**), and so is the candidate limit (`MATCHING_MAX_CANDIDATE_POOLS`, default **10**; nearest-first, with `created_at` and `id` breaking ties so the list is reproducible).

Proximity is a **shortlist and nothing more**. A pool metres from the pickup is still refused if no insertion of the new stops can satisfy the waiting, duration and detour rules -- the tests assert both halves of that.

### Stop insertion

For each shortlisted pool, every legal way of putting the new pickup and drop-off into the existing stop order is routed, measured and judged:

1. load the pool's stops in sequence order;
2. every ordered pair of positions `(pickup, dropoff)` with `pickup < dropoff` -- `n + 2` positions choose 2, so a one-member pool gives six plans and a three-member pool gives fifteen. The new passenger is always collected before being delivered, and the existing stops keep their relative order;
3. route the driver's approach to the first stop, then every consecutive pair; a pair the router cannot connect makes that plan infeasible rather than a failure;
4. measure: total and added distance and duration, planned arrival time at every stop, the new passenger's wait, and each existing passenger's own ride;
5. simulate occupancy segment by segment;
6. refuse the plan by name (`OCCUPANCY`, `PICKUP_WAIT`, `ADDED_DURATION`, `DETOUR`, `DETOUR_RATIO`, `UNROUTABLE`), score the survivors, and keep the best one for that pool;
7. keep the best plan across all pools.

The router is memoised per pool evaluation, which is what makes a quadratic number of insertion positions affordable: a four-stop pool has fifteen plans but only a handful of distinct place-to-place pairs.

**Why the pool's own plan is measured again.** The plan a proposal is compared against is the pool's *current* stop order, routed at the same instant the proposal is routed. Using the pool's stored duration instead would compare two departure instants: a pool priced at 08:41 and re-measured at noon would make every later join look like it *saved* time. `addedDistanceMeters` and `addedDurationSeconds` therefore mean "what this insertion costs on top of what the car was already going to do", and the score never rewards a negative.

**Why arrivals are re-anchored instead of re-routed.** A proposal stores its legs as numbers, so acceptance can move the whole plan to a later instant by adding the same offset to every arrival -- no pgRouting call inside the acceptance transaction, and no re-planning that a driver did not agree to.

### Capacity, waiting and detour rules

Capacity is checked on **every segment**, not by counting members: `PICKUP` is `+1`, `DROPOFF` is `-1`, and a plan is refused if occupancy goes negative, exceeds `capacitySnapshot` at any point, delivers somebody who was never collected, collects or delivers the same passenger twice, or does not end at zero. That is what makes "a drop-off releases a seat" true rather than assumed.

Every limit is configuration, and each one that fires is recorded on the request's timeline by name:

| Limit | Default | Measured from |
| ----- | ------- | ------------- |
| `MATCHING_WINDOW_SECONDS` | 300 s | the request's `requestedAt` -- after this, no existing pool is even considered |
| `MATCHING_MAX_PICKUP_WAIT_SECONDS` | 480 s | the request's `requestedAt`, so it includes the matching delay and the approach |
| `MATCHING_MAX_ADDED_DURATION_SECONDS` | 600 s | the pool's current plan, routed at the same instant |
| `MATCHING_MAX_DETOUR_SECONDS` | 600 s | each existing passenger's `acceptedDurationSeconds` -- the promise their own quote froze |
| `MATCHING_MAX_DETOUR_RATIO` | 1.25 | the same baseline, as a multiple |

The clock is injectable and `requestedAt` is stored, so every number above is deterministic: the tests assert plan metrics with exact arithmetic on a fixture whose distances are literal.

### Scoring and tie-breaking

```text
score = addedPoolDurationSeconds
      + newPassengerPickupWaitSeconds  x MATCHING_PICKUP_WAIT_WEIGHT   (default 1)
      + worstExistingPassengerDetourSeconds x MATCHING_DETOUR_WEIGHT   (default 1)
```

All three terms are seconds, so with the default weights the score reads as *"seconds of harm this insertion does"* and the weights are a way of saying whose seconds matter more -- not arbitrary multipliers. The components are stored separately on the offer so a decision can be explained after the fact.

Plans are ordered by: lowest score, lowest added duration, shortest wait, **oldest pool**, stable pool id, stable stop-order signature. The last two are what make matching reproducible: two genuinely equivalent pools are ordered by an id rather than by whichever rows a query happened to return, so the same situation always produces the same offer. Nothing is random, and nothing depends on row order.

### The `ADD_PASSENGER` offer

| Column | Meaning |
| ------ | ------- |
| `offer_type` | `ADD_PASSENGER`. A `CHECK` requires `ride_pool_id` and a positive `pool_version` with it |
| `ride_pool_id` | the pool being changed |
| `pool_version` | the version the plan was built from -- the promise acceptance later checks |
| `proposal_snapshot` | the whole plan: stops in order with ids and planned arrivals, legs, approach, totals, added distance and duration, the new passenger's wait and ETA, per-existing-passenger detour seconds and ratio, peak occupancy and the occupancy timeline, the score and its components, the limits it was judged by, the route geometry and the rule version |

The row is **immutable** after it is written (`enforce_dispatch_offer_update`): driver, request, vehicle, approach, score, proposal and pool version cannot change, and only the status, the response and the timestamps can. A driver client can read the proposal and cannot submit one -- `POST /drivers/me/offers/:id/accept` takes no body at all, and any field a client sends is a `400`.

One request may have at most one pending offer of either kind, one pool at most one pending route change (`one_pending_route_change_offer_per_pool`), and one driver at most one pending offer (`one_pending_offer_per_driver`, which supersedes the initial-offer-only index of the previous milestone). A pool's driver stays `RESERVED` while holding a join offer: they were committed to the pool before it and they still are.

`GET /api/drivers/me/offers` returns both kinds, and a join offer carries what a driver needs to decide: the new passenger's pickup and destination, the vehicle capacity with the peak occupancy this plan would reach, the added distance and duration, the wait and the driver's ETA to the new pickup, the worst detour an existing passenger would take, and `currentStops` beside `proposedStops` (with `isNew` marking the two that would be added). No fare, and no identity beyond an id a driver never sees elsewhere.

### Acceptance

One transaction, in this order:

1. lock the request, then the offer -- the same order every other path uses;
2. refuse if the offer is not this driver's, is not `PENDING`, or has expired (expiring it and reporting `409`);
3. confirm the request is still `WAITING` and has no member;
4. lock the pool: it must be the driver's, still `FORMING`, and **still the version the offer named** -- otherwise the offer is `CANCELLED` with a `stale_pool_version` event and nothing is written;
5. confirm the driver is still `RESERVED` for it and the member count is still below capacity -- recomputed here, never trusted from the offer;
6. lock the stops and confirm every one is still `PENDING`;
7. confirm the stored plan is still *this* pool's plan: same rule version, same pool, and the existing stops in the snapshot are exactly the stops that exist now, in order;
8. re-simulate occupancy on the stored plan, re-anchor the arrivals to now, and re-validate the wait and the detour limits against the acceptance clock;
9. resequence the stops safely, insert the member (`ASSIGNED`) and its two stops, and update the pool's route, distances and **version**;
10. move the request `WAITING -> MATCHED`, mark the offer `ACCEPTED`, and append `PASSENGER_MATCHED`, `POOL_JOIN_ACCEPTED`, `MEMBER_ADDED` and `ROUTE_PLAN_UPDATED`.

**Resequencing is offset-based.** `UNIQUE (ride_pool_id, sequence)` is checked per statement, so numbered stops cannot be shifted one at a time -- an intermediate state would collide. Existing sequences are moved by `+1000` first, then the new stops are inserted and every stop is given its final number. The existing rows keep their ids, so their arrival history stays attached.

The driver remains `RESERVED`, the existing passengers' requests and stops are untouched, and **no fare is recalculated**: each passenger keeps the solo fare their own quote froze. Sharing is not priced in this milestone.

### Pool versioning and the last seat

`ride_pools.version` is optimistic concurrency for plans. A proposal records the version it was built from, every accepted plan change increments it, a refusal or an expiry leaves it alone, and a conditional update (`WHERE id = $1 AND version = $2`) is what actually moves it -- so two writers cannot both apply a plan to the same version.

The last seat is protected by refusing the race, not by detecting it:

| Race | What settles it |
| ---- | --------------- |
| Two requests for one pool's last seat | `one_pending_route_change_offer_per_pool`: only one can hold the offer, and the loser is told to wait rather than being handed a seat that is about to be taken |
| One join offer accepted twice | the request's row lock, then the offer's, then a conditional status update |
| A stale plan accepted | the pool's version, compared under the pool's row lock |
| Capacity reduced or a member added since the offer | the member count is recomputed inside the transaction |
| Acceptance vs cancellation | the request's row lock, taken first by both |
| Acceptance vs expiry | the offer is re-read under its lock and the deadline re-checked |
| Two pools, one request | `one_pending_offer_per_request` |
| Stop sequences during resequencing | the offset pass, plus `UNIQUE (ride_pool_id, sequence)` |

The concurrency tests assert an invariant rather than a winner: after a cancellation racing an acceptance the request is either `MATCHED` with a two-member pool or `CANCELLED` with a one-member pool, and after an expiry racing an acceptance the offer is either `ACCEPTED` or `EXPIRED` -- never both, and never a pool that grew without a match.

### Refusal, expiry and fallback

A refused join changes nothing: no member, no stops, no version, no route. The offer goes to `REJECTED` with its reason, a `POOL_JOIN_REJECTED` event is appended, and the request is re-assigned -- so the *next* compatible pool is tried, and the pool that refused is excluded for that request (and that driver) from then on. The same applies to expiry, which is the existing sweeper: mark it `EXPIRED`, leave the pool alone, try the next candidate.

When nothing is left, the fallback is the dispatcher that was already there: the same request, still `WAITING`, one `INITIAL_RIDE` offer to the best eligible driver, no pool while the offer is pending, and `EXPIRED` only when `searchExpiresAt` passes. The request's timeline records why each stage happened -- `POOL_CANDIDATE_EVALUATED` with the candidates and their rejection reasons, then `INITIAL_DISPATCH_FALLBACK` with `no_candidate_pools`, `no_feasible_plan`, `matching_window_closed` or the stale-offer reason.

### Events

Ride timeline: `POOL_CANDIDATE_EVALUATED`, `POOL_JOIN_OFFERED`, `POOL_JOIN_REJECTED`, `POOL_JOIN_ACCEPTED`, `INITIAL_DISPATCH_FALLBACK` -- and `PASSENGER_MATCHED`, the existing match event, which is reused rather than duplicated so a matched request has exactly one "this is the ride you got" event whichever way it was matched.

Pool timeline: `JOIN_PLAN_CREATED` when a join is proposed, then `MEMBER_ADDED` and `ROUTE_PLAN_UPDATED` when one is accepted. Metadata carries the rule version, the score, added distance and duration, the wait and detour metrics, occupancy before and after, the pool version before and after, and the accepted stop order -- and never a passenger's name or a price.

### Commands

```bash
npm run db:migrate                                 # applies 10-pool-matching.sql (idempotent)
npm run db:seed                                    # the demo cast
npm test                                            # unit + integration
npm run test:unit --workspace server                # the matching rules, with no database
npm run test:integration --workspace server         # candidates, insertion, offers, acceptance, races
npm run dispatch:sweep --workspace server           # also tries the next pool after an expiry
```

### What is deliberately not here

There is **no shared fare or pooling discount** in this section: matching chooses a *plan*, and what that plan costs each passenger is the [next section](#shared-fares). The trip operations are not here either -- driver arrival, trip start, passenger pickup, drop-off and completion are [the milestone after that](#the-drivers-trip) -- and `match` never reads a price. What this section *does* decide, and all a later milestone needed, is that a pool which is no longer `FORMING` is never matched into: departure is what closes it, and nothing else had to change.

Two assumptions worth stating. The occupancy simulation is plan-level, so it proves a *plan* is legal, not that a car was never overfull; the trip milestones are what turn stops into facts. And a pool's stored duration is priced at its own creation instant while proposals are measured at match time, so `addedDurationSeconds` can be negative after a traffic-profile change -- the score clamps it to zero rather than letting a join be rewarded for a clock change, and the limits are checked against the same clamped numbers.


## Shared fares

A pool is a plan, and a plan has a price. This milestone turns the plan into one
versioned, explainable fare per passenger, built from the legs of the journey each
passenger is actually on board for.

```text
leg i -> i+1  costs what it costs to drive
              and is split between the passengers in the car for it
passenger     pays the pool's base fare + their share of every leg they are on,
              capped by their own accepted solo fare
              and by the fare they were last given
```

```bash
# What the passenger is currently being charged, and why.
curl localhost:4000/api/ride-requests/<id>/fare -b passenger-cookies.txt
```

### The rule version

`SHARED_FARE_RULE_VERSION` in `src/services/pool-fare.rules.js` is `pool-leg-share-v2`, and every stored calculation records the version it was made with.

This is not decoration. Any change to the arithmetic changes what passengers are charged, so it has to be published as a **new** version rather than deployed on top of the old one: an old calculation is then still explainable by the rules that produced it, and a new calculation is visibly a different answer rather than a silent correction of history. It is deliberately **not** configuration -- `env.fare.pool` holds the transaction ceiling and nothing else -- so changing it means changing code that a reviewer can see.

### Who pays for which leg

The plan is applied in stop order, and the action at a stop is applied *before* the leg that follows it:

```text
for each stop i, for the leg i -> i + 1:
    a PICKUP at stop i puts that member on board
    a DROPOFF at stop i takes them off
    the resulting set of passengers pays for that leg
```

So a passenger starts paying immediately after being collected and stops the moment they are delivered. Nobody pays for a leg before their pickup, after their drop-off, or for a leg they were never in the car for -- and a leg with **nobody** on board is recorded (the driver drove it, and it has to stay auditable) but funds nothing: all four of its money columns are zero, and `pool_fare_legs_unfunded_is_free` refuses any other combination.

The driver's **approach to the first pickup is not a leg at all** in this milestone: there is no passenger on board for it by definition, so there is nobody to share it with.

A calculation is refused outright when the plan cannot be priced: a stop numbered out of order, a drop-off before its pickup, a passenger collected or delivered twice, a member with only one of their two stops, an occupancy that exceeds the vehicle, or a leg the router cannot connect.

### What a leg costs

For every consecutive pair of stops, the leg is routed through the authoritative routing service, each traversed edge is priced with the policy in force, and the traffic multiplier is applied **once**:

```text
edgeDistanceCost = edgeKilometers × perKilometerRate × edge.fareWeight   [rounded]
distanceCost     = sum(edgeDistanceCost)
timeCost         = legMinutes × perMinuteRate                             [rounded]
preTrafficCost   = distanceCost + timeCost
trafficAdjustment= preTrafficCost × (trafficMultiplier - 1)               [rounded]
totalLegCost     = preTrafficCost + trafficAdjustment
```

Three things about that are deliberate:

- **the fare weight multiplies distance only.** It never reaches the duration, and it never reaches the router -- the shortest path was chosen on duration before any of this ran, so a weight can re-price an edge but cannot move the route;
- **the base fare is not in a leg.** It is a per-passenger amount added later, which is why a leg cost is a property of the road and not of who is in the car;
- **`totalLegCost = preTrafficCost + round(preTrafficCost × (m - 1))` is `preTrafficCost × m` with one rounding instead of two.** The three stored components therefore add up to the stored total exactly (`pool_fare_legs_total_consistent`), and the multiplier cannot be applied twice without the row failing that check.

Every leg keeps a `routeSnapshot`: the edges in travel order with their distance, selected duration, fare weight and the charge the weight produced, plus the profile and the components. The whole leg can be re-priced from that snapshot and the stored policy alone -- the test suite does exactly that and asserts it reproduces the stored numbers -- which is what makes a fare auditable rather than merely recorded.

### Splitting a leg

```text
unroundedShare = totalLegCost / N            (exact decimal, ten decimals)
share          = unroundedShare rounded DOWN to the currency
                 + one currency unit for the first `residual` passengers, in member-id order
```

`10.00` split three ways is `3.3333...` each, which is not an amount anybody can be charged. So each share is floored to the policy's rounding scale, and the remaining whole units are handed out **one each, in a stable order (the pool member id)** until the shares add up to the leg's cost exactly. The consequence is the property that matters: **no money is ever discarded or invented by division rounding** -- the shares of a leg sum to the leg's total, which `passenger_fare_leg_shares_sum_is_exact` (a deferred constraint trigger) refuses to commit otherwise, and one share exists per passenger who was on board.

Each share stores the exact quotient, the amount charged, and the difference between them, so a share can be explained without recomputing the division. Which passenger got the extra unit is visible from the amounts themselves, and is deterministic: the same leg always produces the same split.

### What a passenger owes

```text
allocatedLegCost   = sum(their shares)
uncappedPooledFare = baseFare + allocatedLegCost
afterMinimum       = max(minimumFare, uncappedPooledFare)
afterSoloCap       = min(acceptedSoloFare, afterMinimum)
unroundedFare      = min(previousPooledFareCap ?? afterSoloCap, afterSoloCap)
finalFare          = round(unroundedFare / fareRoundingUnit) × fareRoundingUnit
fareRoundingAdjustment = finalFare - unroundedFare
```

The order is the product's, and the database enforces the result of it:

| Protection | What it guarantees | How it is enforced |
| ---------- | ------------------ | ------------------ |
| **Solo cap** | nobody pays more than the fare their own quote froze | `final_fare <= accepted_solo_fare` |
| **No-increase cap** | adding a passenger never increases an existing passenger's fare | `final_fare <= previous_pooled_fare_cap` when there is one |
| **Minimum fare** | the pool has a floor | `GREATEST(minimum_fare, uncapped_pooled_fare)` |
| **Rounding unit** | the fare is a whole number of taka, and never above either cap | `passenger_fare_allocations_caps_are_whole_units` |

`previous_pooled_fare_cap` is the fare that passenger's **previous** allocation gave them -- from the calculation for the preceding pool version, whatever rule version produced it. A passenger who has just joined has no previous cap, which is what makes their first pooled fare a fresh calculation rather than another ceiling.

When the minimum fare and a protection disagree, **the passenger wins**: a fare can only be reduced by a cap, never raised above one by the floor. The difference is recorded rather than absorbed -- `solo_cap_reduction`, `no_increase_reduction` and, on the calculation, `total_minimum_fare_uplift`, which is the part of a fare no passenger produced. The row's arithmetic has to close:

```text
final_fare + solo_cap_reduction + no_increase_reduction
  = GREATEST(minimum_fare, uncapped_pooled_fare)
```

so a fare with an unexplained difference cannot be written by any code path, including one added later by mistake.

### Rounding a pooled fare

Each passenger's fare is snapped **individually**, at the end of their own chain of protections, to the nearest whole multiple of the policy's `fareRoundingUnit` -- the same rule a solo quote follows, applied per person. `fareRoundingAdjustment` records what the snap moved, and the calculation's `total_fare_rounding_adjustment` is the sum, so rounding is money that is accounted for rather than a gap between two totals.

The snap touches the **fare** and nothing underneath it. The leg costs and the leg shares keep the policy's rounding scale, which is exactly what keeps `passenger_fare_leg_shares_sum_is_exact` true: splitting a leg is arithmetic, and a leg whose shares were each snapped to ten taka would no longer add up to the leg. It also keeps the caps meaningful -- every fare this project writes is a whole number of units, so both caps are, and the nearest multiple of a unit to a fare at or below a cap cannot be above that cap. See [The rounding unit and the caps](#the-rounding-unit-and-the-caps) for the one-line proof.

The row's arithmetic therefore closes with one more term:

```text
final_fare + solo_cap_reduction + no_increase_reduction
  = GREATEST(minimum_fare, uncapped_pooled_fare) + fare_rounding_adjustment
```

### One passenger, no invented discount

For a one-member pool the passenger receives the whole of every funded leg and pays the base fare on top of it. Nothing is split, so nothing is discounted -- and off-peak, where the traffic multiplier is `1.00`, that fare is **exactly** the accepted solo fare. At rush hour it is slightly *below* it, for a reason worth stating: a solo quote applies the multiplier to its whole subtotal including the base fare, while a pooled base fare is a fixed per-passenger amount and only the driving is traffic-scaled. That is a property of `pool-leg-share-v2`, not a discount anybody invented, and it is in the direction of the guarantee: no passenger ever pays more than their quote.

### Versioning: one answer per plan

| Rule | What enforces it |
| ---- | ---------------- |
| At most one `CURRENT` calculation per pool | partial unique index `one_current_pool_fare_calculation_per_pool` |
| At most one calculation per (pool version, rule version) | unique `pool_fare_calculations_version_rule_unique` |
| Amounts, versions and the policy are write-once | `enforce_pool_fare_calculation_update` trigger: only `status` may move, and only `CURRENT -> SUPERSEDED or FINALIZED` |
| Legs, allocations and shares are append-only | a trigger per table refuses any `UPDATE` |
| A fare never moves without a plan change | the calculation is written inside the acceptance transaction, not after it |

Because the pair (pool version, rule version) is unique, recalculating is **idempotent**: a retry, a sweep or a second caller finds the stored answer and writes nothing. Because the plan version is checked under the pool's row lock, asking for a version the pool has moved past is a `409` rather than a calculation of something that no longer exists.

`SUPERSEDED` rows are kept forever: the history of what each passenger was quoted at every step is the audit trail, and it is also where the no-increase cap reads its ceiling from. `FINALIZED` is written by [the trip milestone](#the-drivers-trip): departure moves the pool's `CURRENT` calculation to `FINALIZED` with `finalized_at`, so the passengers travel under exactly the numbers they were last shown, and `finalized_at` is refused unless the status is `FINALIZED`.

### When it runs

A pool's plan is what its fares are made of, so a calculation is written whenever the plan changes -- and **inside the transaction that changes it**:

1. the initial pool acceptance, which produces version 1;
2. an accepted `ADD_PASSENGER` offer, which produces the next version;
3. and `recalculatePoolFaresStandalone`, for a pool whose calculation is missing or stale.

That is the guarantee the whole design is built around: **a successful plan change cannot commit without a valid calculation**, so a matched passenger can never exist without a fare. If the calculation fails -- the pricing is not configured, a leg cannot be routed, the plan cannot be priced -- the member, the stops, the route, the version bump and the request's status change all roll back with it. The test suite proves it by breaking the pricing and asserting that the join left nothing behind.

The cost of the guarantee is real and worth naming: the critical section now routes every leg of the plan (a handful of short pgRouting queries) rather than reusing durations from a plan computed earlier. Pricing a plan that has not been written yet, or writing one that cannot be priced, would both be worse.

The repair command exists for the two cases the trigger cannot cover -- a plan change that predates this milestone, and a calculation a deployment has since fixed:

```bash
npm run pool-fares:recalculate --workspace server
```

It examines forming pools whose calculation is missing or stale for their current version, recalculates those, and reports what it did. It is idempotent, safe to run repeatedly, and skips (rather than guesses at) a pool whose plan moves while it runs.

### Reading a fare

`GET /api/ride-requests/:id/fare` returns the authenticated passenger's own allocation:

```json
{
  "rideRequestId": "…",
  "fareStatus": "ESTIMATED",
  "calculationStatus": "CURRENT",
  "currency": "BDT",
  "acceptedSoloFare": "110",
  "currentPooledFare": "100",
  "baseFare": "40.00",
  "allocatedLegCost": "55.42",
  "uncappedPooledFare": "95.42",
  "minimumFare": "80.00",
  "minimumFareApplied": false,
  "unroundedFare": "95.42",
  "fareRoundingAdjustment": "4.58",
  "legsPaidFor": 2,
  "previousPooledFare": null,
  "soloCapApplied": false,
  "noIncreaseCapApplied": false,
  "soloCapReduction": "0.00",
  "noIncreaseReduction": "0.00",
  "totalReduction": "0.00",
  "savedAgainstSoloFare": "10",
  "pricingCode": "dhaka-solo",
  "pricingVersion": 1,
  "sharedFareRuleVersion": "pool-leg-share-v2",
  "poolVersion": 2,
  "calculatedAt": "2026-09-25T06:12:44.118Z"
}
```

`fareStatus` is `ESTIMATED` while a pool is still forming, and `FINALIZED` once the driver has departed: the freeze is what commits the passengers to the numbers they were last shown. `calculationStatus` distinguishes a current answer from a superseded one. A fare stays readable after departure, which is what lets a passenger look up what they are travelling under.

**Privacy is structural, not a filter.** The response is derived from one allocation, so there is no shape of it in which another passenger's fare, the pool's revenue, or the platform's share of somebody else's minimum fare could appear -- the serializer is not given those numbers. There is deliberately no route that takes a pool id: a passenger cannot ask about a pool, and therefore cannot ask about the people in it. Another passenger's request is a `404` (not a `403`, so request ids cannot be probed), a driver is refused by the role guard, and before a request is matched there is no pooled fare to report, which is a `404` as well rather than an invented `0.00`. Drivers see no fares at all: the driver endpoints carry plans, not money.

### Commands

```bash
npm run db:migrate                                  # applies 11-pool-fares.sql (idempotent)
npm test                                             # unit + integration
npm run test:unit --workspace server                 # the fares rules, with no database
npm run test:integration --workspace server          # the ledger, the caps, the races, privacy
npm run pool-fares:recalculate --workspace server    # repair: price any stale pool
```

### What is deliberately not here

There is **no payment, wallet, refund, driver payout, cancellation fee, tax, promo code or settlement**. A fare is frozen by departure ([the driver's trip](#the-drivers-trip)) and never charged: `FINALIZED` is a commitment about arithmetic, not a movement of money, and a settlement milestone is what would collect it. A fare here is an estimate for a plan that has not started -- every stop must still be `PENDING` for a calculation to be *written*, and a pool whose trip has begun is refused with a `409` rather than re-priced.

Two limitations worth stating plainly. The occupancy behind a fare is the *plan*: this milestone prices what the plan says will happen, and the trip milestone is what turns a stop into a fact. And a fare is recomputed from the current plan rather than adjusted incrementally, so a fare is only ever as current as the last plan change -- which is exactly why the plan change and the calculation share a transaction, and why departure has to freeze the answer before the car moves.


## The driver's trip

A pool is a plan. This milestone is the driver executing it: setting off, reaching
each stop, collecting the passengers, starting the journey, delivering them one by
one, and finishing. It is the point at which every "planned" thing in the previous
sections becomes a fact, and the only milestone in which the driver calls the API
instead of answering it.

```text
FORMING  --depart-->  DRIVER_EN_ROUTE  --arrive (first pickup)-->  ARRIVED
                                                                    |
                                                          --start (passengers aboard)-->
                                                                    |
                                                              IN_PROGRESS  --complete-->  COMPLETED
```

```bash
# What am I committed to, and what may I do next?
curl localhost:4000/api/drivers/me/current-pool -b driver-cookies.txt

# Set off. Then reach a stop, collect a passenger, start, deliver, finish.
curl -X POST localhost:4000/api/drivers/me/pools/<id>/depart -b driver-cookies.txt
curl -X POST localhost:4000/api/drivers/me/pools/<id>/stops/<stopId>/arrive -b driver-cookies.txt
curl -X POST localhost:4000/api/drivers/me/pools/<id>/stops/<stopId>/members/<memberId>/pickup -b driver-cookies.txt
curl -X POST localhost:4000/api/drivers/me/pools/<id>/start -b driver-cookies.txt
curl -X POST localhost:4000/api/drivers/me/pools/<id>/stops/<stopId>/members/<memberId>/dropoff -b driver-cookies.txt
curl -X POST localhost:4000/api/drivers/me/pools/<id>/complete -b driver-cookies.txt
```

### Departure, and what it closes

Departing is `FORMING -> DRIVER_EN_ROUTE` and nothing else. It is the *only* moment
a pool stops being matchable: shared matching considers `ELIGIBLE_POOL_STATUSES`,
which is `FORMING` alone, so after this a new passenger can never be folded into a
plan that is already being driven. It is the same transaction that **freezes the
fare**: the pool's `CURRENT` `pool_fare_calculations` row moves to `FINALIZED` with
`finalized_at`, and the passengers travel under exactly the numbers they were last
shown. A trip cannot start without that freeze (`FARE_NOT_FINALIZED`), so a fare can
never be settled after the fact by a driver who forgot to depart.

Departure is also what cancels the offers it invalidates. A pending `ADD_PASSENGER`
offer to another driver is answered `409` by a departing pool, because the answer
would be a promise about a plan that is no longer a plan. Departure pulls the
driver's own pending offers closed first and then, best-effort, re-dispatches the
passengers those offers were holding -- a refusal here never blocks the departure.

### The stop order, and why a corner is two stops

```text
the next actionable stop = the lowest-sequence stop whose status is not COMPLETED
```

A `pool_stops` row names **one member and one stop type**, so two passengers
collected at the same corner are two stops at the same service point in consecutive
order. That single rule is what makes "a shared corner stays open until everybody
there is in the car" fall out of the design rather than being special-cased: after
the first of the two pickups the second is still the next actionable stop, so the
driver cannot skip it and cannot reach a later stop first.

Reaching a stop the driver has already passed, or any stop that is not the next
actionable one, is a `409` (`STOP_NOT_NEXT`). There is no "set my position" call: the
driver's place in the journey *is* the stops they have finished.

### Arriving

`POST .../stops/:stopId/arrive` writes `actual_arrival_at` and moves the stop to
`ARRIVED`. Arriving at the **first pickup** is what moves the pool out of
`DRIVER_EN_ROUTE` and into `ARRIVED`; later arrivals leave the pool exactly as it is,
because the trip has its own clock from there.

A pickup stop that is reached also writes a `DRIVER_ARRIVED` event onto the
passenger's own timeline -- and **only** a pickup stop does. A delivery stop is not a
promise that a car is coming for anybody, so it never claims one.

Reaching a stop is not the same as serving it: a stop can be `ARRIVED` and still
`PENDING` in the sense that its passenger has not been confirmed into the car. The
stop status is what the *driver* did; the member status is what happened to the
*passenger*, and the two are written together.

### Collecting a passenger

`POST .../stops/:stopId/members/:memberId/pickup` requires the stop to be the next
actionable one, to be a `PICKUP`, and to be *that passenger's* own stop
(`MEMBER_NOT_ON_STOP` otherwise), so a driver cannot complete somebody else's stop by
naming the wrong member. It sets `picked_up_at`, the stop to `COMPLETED`, the member
to `PICKED_UP`, and the event on both timelines.

The passenger's *ride* is not started by this. A passenger collected before the trip
starts stays `MATCHED`; one collected **during** a trip that is already `IN_PROGRESS`
has their ride begin immediately (`collected_during_trip`), because they are being
driven the moment they get in.

### Starting the trip

`POST .../start` requires `ARRIVED`, at least one passenger aboard, and **no pickup
still open at the next actionable stop** (`PICKUP_ACTION_OPEN`). It sets
`started_at` on the pool, moves every `MATCHED` request of every passenger already
aboard to `IN_PROGRESS` with their own `started_at`, and writes `TRIP_STARTED`.

The rule is deliberately local, and it is what makes staggered pooling work: the trip
starts where the driver currently is, so a passenger waiting **later** along the route
is still `MATCHED` and is collected into a running trip. There is no requirement that
everyone in the pool is aboard before the car moves.

### Delivering a passenger

`POST .../stops/:stopId/members/:memberId/dropoff` requires the next actionable stop,
a `DROPOFF`, and that the passenger is `PICKED_UP`. It sets `dropped_off_at`, the stop
to `COMPLETED`, the member to `DROPPED_OFF`, **that request to `COMPLETED`** with its
own `completed_at`, and writes `MEMBER_DROPPED_OFF`.

Completion is per passenger: the pool keeps carrying whoever is still in the car, and
a passenger who has been delivered is finished with this pool even though the trip
has not ended. `pool_members.dropped_off_at` and `ride_requests.completed_at` are two
instants proving two different things -- one passenger's stop, and one ride -- and the
second is what their history is built from.

### Completing the trip

`POST .../complete` is the only operation that is purely about **facts**, and it
refuses if any of them is missing:

| Requirement | Refusal |
| ----------- | ------- |
| the pool is `IN_PROGRESS` | `POOL_NOT_IN_PROGRESS` |
| every stop is `COMPLETED` | `STOPS_UNFINISHED` |
| nobody is still `PICKED_UP` | `MEMBERS_ONBOARD` |
| every passenger is `DROPPED_OFF` | `MEMBERS_ONBOARD` |
| every ride is `COMPLETED` | `REQUESTS_UNFINISHED` |
| the fare was frozen before the trip | `FARE_NOT_FINALIZED` |

There is no "close it anyway", because completing with a passenger aboard would strand
a ride request in a state no later operation could repair. Completion sets
`completed_at`, writes `TRIP_COMPLETED`, and **releases the driver**: the driver goes
`ON_RIDE -> AVAILABLE` at the final drop-off's service point, with `availableSince`
and `lastSeenAt` moved to now, and a `DRIVER_AVAILABLE` event. The driver is therefore
dispatched from where the trip actually ended rather than from where it began.

### Idempotency is a property of the state, not a token

None of these endpoints takes an idempotency key. A repeated command is answered by
the **state it produced**:

| Decision | Meaning | Response |
| -------- | ------- | -------- |
| `APPLY` | do it | `200`, the command happened |
| `REPEAT` | this exact operation already succeeded | `200`, the current state, nothing written |
| `REFUSE` | the resources exist but the order or state is wrong | `409` with a named reason |

A `REPEAT` moves **no timestamp and writes no event** -- the test suite asserts this by
comparing the whole rows and the whole event lists before and after, not just the
status. It is checked *before* any "the trip is over" refusal, so a driver whose
network dropped mid-request can retry a pickup after the trip completed and get their
answer rather than a `409` about a trip that is over. And the timestamps are written
from the state, never from the retry, so a second `arrive` cannot make the driver
arrive twice.

### Concurrency

Each command runs in one transaction and locks what it touches, always in the same
order: **the pool, its stops, its member requests, then the driver.** The row lock on
the pool is what serialises two commands on the same trip, and the lock on the driver
is what makes the release at completion atomic with the rest.

There is one exception, and it is documented at the top of `trip.service.js`: a
departure writes a `DRIVER_OFFER_CANCELLED` event onto *other* passengers' timelines,
so those requests are locked **first**, in ascending id order, before the pool. Taking
the pool first would let a departure hold the pool while waiting for a request that an
offer acceptance holds while waiting for the pool -- a deadlock the test suite
provokes with two commands issued at once.

### The response: `allowedActions` is computed, not told

```json
{
  "pool": {
    "poolId": "…",
    "status": "ARRIVED",
    "version": 2,
    "capacity": 3,
    "vehicle": { "name": "Bullet", "seatCapacity": 3 },
    "plan": { "distanceMeters": 2214, "durationSeconds": 569, "stopCount": 3 },
    "stops": [
      { "stopId": "…", "sequence": 1, "stopType": "PICKUP", "status": "ARRIVED",
        "servicePoint": { "code": "banani-road-11", "name": "Banani Road 11" },
        "plannedArrivalAt": "…", "actualArrivalAt": "…", "completedAt": null }
    ],
    "nextStop": { "stopId": "…", "sequence": 1, "stopType": "PICKUP", "status": "ARRIVED" },
    "allowedActions": ["PICKUP_PASSENGER"],
    "pricing": { "finalized": true, "finalizedAt": "…", "poolVersion": 2 },
    "departedAt": "…",
    "members": [
      { "memberId": "…", "status": "ASSIGNED", "rideStatus": "MATCHED", "displayName": "Nusrat",
        "pickup": { "code": "banani-road-11" }, "dropoff": { "code": "mohakhali-bus-terminal" },
        "matchedAt": "…", "pickedUpAt": null, "droppedOffAt": null, "stops": [ … ] }
    ],
    "events": [ { "sequence": 1, "eventType": "POOL_CREATED", "actorType": "DRIVER", "createdAt": "…" } ]
  }
}
```

`allowedActions` lists an action **only when its own decision would be `APPLY`**, so a
driver's client is never offered a button that would answer `409` -- and an action that
has already succeeded is absent, because there is nothing left to do about it. It is
computed from the state on every read rather than stored, so it cannot drift from the
rules that enforce it: the same `trip.rules.js` that answers the request answers this
field. `GET /drivers/me/current-pool` is the canonical name (`/drivers/me/pool` still
answers identically, so an earlier caller does not break), it is wrapped in a `pool`
key like every other allowance-shaped read, and it reports the driver's pool whether it
is still `FORMING` or already `COMPLETED` -- which is what makes it the one endpoint a
client needs to poll. `pool` is `null` rather than an error for a driver with no pool,
which is the same answer a fresh driver and a driver whose trip has finished get.

`pricing.finalized` is a **boolean and a version, never an amount**: the driver is told
whether the money is frozen, not what it is, and the driver DTO carries no fare at all.

### What the passenger sees

`GET /api/ride-requests/:id` gains a `trip` block, and the fare endpoint reports the
settled status once the trip has begun:

```json
{
  "trip": {
    "poolId": "…",
    "poolStatus": "IN_PROGRESS",
    "memberStatus": "PICKED_UP",
    "stage": "PICKED_UP",
    "driver": { "displayName": "Jashim" },
    "vehicle": { "name": "Bullet", "seatCapacity": 3 },
    "stops": [ { "stopId": "…", "sequence": 1, "stopType": "PICKUP", "status": "COMPLETED" } ],
    "nextStop": { "stopId": "…", "sequence": 2, "stopType": "DROPOFF", "status": "PENDING" },
    "timeline": {
      "matchedAt": "…", "departedAt": "…", "driverArrivedAt": "…",
      "pickedUpAt": "…", "droppedOffAt": null
    },
    "events": [ { "sequence": 3, "eventType": "DRIVER_DEPARTED", "actorType": "DRIVER", "createdAt": "…" } ]
  }
}
```

`stage` is **derived from the timestamps, never stored**, because a stored stage is a
second source of truth that can disagree with the instants that justify it:

```text
DRIVER_ASSIGNED   a driver accepted; nobody has set off
DRIVER_EN_ROUTE   the driver left for the first pickup
DRIVER_ARRIVED    the car is at *this* passenger's pickup
PICKED_UP         this passenger is in the car, the trip has not started
IN_PROGRESS       this passenger's ride has begun
RIDE_COMPLETED    this passenger has been delivered
```

Every field is about *this* passenger: the arrival instant is their own pickup stop's,
the completion is their own ride's -- which happens while the pool may still be
carrying somebody else -- and the pool's status and departure are the only shared facts
in it. The driver is a first name and a car, as in the rest of the driver-facing
surface; a passenger who is not in a pool gets no `trip` at all rather than an empty
one, and another passenger's request is still a `404`.

### Events

`pool_events` gains `DRIVER_DEPARTED`, `STOP_ARRIVED`, `TRIP_STARTED`, `TRIP_COMPLETED`
and `DRIVER_AVAILABLE`; `ride_events` gains `DRIVER_ARRIVED`. Every one is written in
the same transaction as the state change it records, so a timeline cannot claim
something the state does not show, and the tables still refuse `UPDATE` -- a retry
finds the event already there and writes no second one.

### What the database enforces

`server/db/12-driver-trip.sql` adds the instants and the consistency they imply, so a
state that cannot be reached cannot be *written* either:

| Column | New |
| ------ | --- |
| `ride_pools.departed_at` | yes |
| `pool_stops.completed_at` | yes |
| `ride_requests.started_at`, `ride_requests.completed_at` | yes |
| `pool_members.picked_up_at`, `dropped_off_at` | no -- already existed, and are now reachable |
| `ride_pools.driver_arrived_at`, `ride_pools.started_at`, `ride_pools.completed_at`, `pool_stops.actual_arrival_at` | no -- already existed, and are now written |

and four `CHECK`s: `ride_pools_lifecycle_consistent` (a pool that is not `FORMING` has
departed; `IN_PROGRESS` iff `started_at`; `COMPLETED` iff `completed_at`; `CANCELLED`
iff `cancelled_at`; a completed or cancelled pool may not also be under way),
`pool_stops_lifecycle_consistent` (`ARRIVED` has an arrival, `COMPLETED` has both,
`PENDING` has neither), `pool_members_lifecycle_consistent` and
`ride_requests_lifecycle_consistent` (`IN_PROGRESS` or `COMPLETED` iff `started_at`;
`COMPLETED` iff `completed_at`).

The migration also adds `ride_requests_passenger_completed_at_idx`, the index a
passenger's finished-ride history reads through, and it **rewrites the two existing
lifecycle checks** rather than adding a second one that could disagree.

A note on names: the brief called the third pool state `DRIVER_ARRIVED`, which is the
`ARRIVED` enum value this schema has had since matching; and the stop instant the brief
called `actual_completed_at` is `pool_stops.completed_at` here. Nothing was renamed, so
no previously applied migration had to be edited -- the only instants genuinely missing
were `ride_pools.departed_at`, the completion of a stop, and the two on the ride
request itself.

### Commands

```bash
npm run db:migrate      # applies 12-driver-trip.sql (idempotent, safe to re-run)
npm test                 # unit + integration
npm run test:unit --workspace server         # the trip rules, with no database
npm run test:integration --workspace server  # the six endpoints, the races, the boundary
```

### What is deliberately not here

**No passenger cancellation, no driver cancellation, no no-show handling, no payments
or refunds, no live GPS, no WebSockets or notifications, no ratings, no frontend code
and no rematching after departure.** A cancelled pool, a `SKIPPED` stop and a
`CANCELLED` or `NO_SHOW` member are defined in the schema and reached by no code path;
the trip suite asserts that after a full journey the counts of all of them are still
zero. There is no "driver is late" operation and no way to move a stop: the plan a
passenger was priced against is the plan that is driven.

Two limitations worth naming. Location is **declarative**: the API records that a
driver reached a stop, and never checks that they were physically there -- the client
is trusted, which is the honest design until there is a GPS milestone to check it
against. And the trip is driven by the driver alone: nothing expires a stop that is
never served, so a driver who abandons a journey mid-trip leaves a pool `IN_PROGRESS`
until a cancellation milestone exists to close it.


## Reading a ride

Every milestone before this one built the API a client *writes* to: quote, request,
accept, depart, collect. This one builds the API a client **reads**: what am I on
now, what have I done, and what may I do next. It is the layer a passenger and a
driver app is actually made of.

```bash
# The passenger: where am I in my journey, and what should I do?
curl localhost:4000/api/passengers/me/current-ride -b passenger-cookies.txt

# Their history, filtered and paged.
curl 'localhost:4000/api/passengers/me/rides?status=COMPLETED&limit=20' -b passenger-cookies.txt

# One ride, with its own stops and its own timeline.
curl localhost:4000/api/passengers/me/rides/<rideRequestId> -b passenger-cookies.txt

# The driver: the same questions, about the pool instead of the request.
curl localhost:4000/api/drivers/me/current-pool -b driver-cookies.txt
curl 'localhost:4000/api/drivers/me/rides?from=2026-09-01T00:00:00Z' -b driver-cookies.txt
curl localhost:4000/api/drivers/me/rides/<poolId> -b driver-cookies.txt

# One call for the whole availability toggle.
curl -X PATCH localhost:4000/api/drivers/me/availability -b driver-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"online":true,"servicePointCode":"banani-kakoli"}'
```

### A passenger's history is requests; a driver's is pools

The two are not the same shape, and the difference is the product rather than the
schema. A passenger's history is a list of **ride requests**, because one request
is one passenger's journey. A driver's history is a list of **pools**, because a
pool is one car's journey: a driver who carried three passengers drove one trip,
not three. Reporting a driver's history per request would show the same journey
three times and make "how many trips did I drive" unanswerable.

The passenger side also keeps two levels apart. `GET /passengers/me/rides` returns
**summaries** — enough for a list — while `GET /passengers/me/rides/:id` adds the
passenger's own stops, their own lifecycle timeline and the pool they shared. The
list deliberately does not load each ride's stops and events, because that would be
a query per row to answer a question a list page is not asking.

### The current ride, and why it is a 200 with `null`

`GET /passengers/me/current-ride` answers the passenger's single active request
(`WAITING`, `MATCHED` or `IN_PROGRESS` — the database allows at most one), with a
`stage` and a `nextAction`:

```json
{
  "ride": {
    "rideRequestId": "86274eb8-0f84-42b3-b2b8-3619d7c7f902",
    "status": "MATCHED",
    "stage": "DRIVER_EN_ROUTE",
    "nextAction": "WATCH_DRIVER",
    "pickup": { "code": "banani-road-11", "name": "Banani Road 11" },
    "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
    "driver": { "displayName": "Jashim" },
    "vehicle": { "name": "Bullet", "seatCapacity": 3 },
    "passengerCount": 1,
    "myStops": [
      { "stopId": "…", "sequence": 1, "stopType": "PICKUP", "status": "PENDING",
        "servicePoint": { "code": "banani-road-11", "name": "Banani Road 11" } }
    ],
    "sharedFare": { "fare": "130", "currency": "BDT", "finalized": true, "poolVersion": 1 },
    "timeline": { "matchedAt": "…", "departedAt": "…", "driverArrivedAt": null }
  }
}
```

A passenger who is not riding gets `200` with `{ "ride": null }`, not a `404`. Not
being on a journey is a normal state rather than a missing resource, so a client
polling this endpoint does not have to treat the ordinary answer as an error — the
same choice the driver's current-pool endpoint makes with `{ "pool": null }`. A
named resource that is not the caller's *is* a `404`, and a fare that does not
exist yet is a `404` rather than an invented `0.00`.

`stage` and `nextAction` are **derived from the timestamps on every read**, never
stored:

```text
DRIVER_ASSIGNED  WAIT_FOR_DRIVER    a driver accepted; nobody has set off
DRIVER_EN_ROUTE  WATCH_DRIVER       the driver left for the first pickup
DRIVER_ARRIVED   BOARD_VEHICLE      the car is at *this* passenger's pickup
PICKED_UP        IN_RIDE            in the car, the trip has not started
IN_PROGRESS      IN_RIDE            this passenger's ride has begun
RIDE_COMPLETED   RIDE_FINISHED      delivered
```

A stored stage would be a second source of truth that can disagree with the
instants that justify it, and a stored "next action" is a button that can be wrong.
Both come from `trip.rules.js`, which is the same module the trip commands use, so
a client is never offered an action the server would refuse.

### Privacy: structural, not a filter

This is where the read APIs are most deliberate, and the design is the same one the
fare milestone used: **a response is built from one passenger's rows**, so there is
no shape of it in which another passenger could appear.

| A passenger never receives | How |
| -------------------------- | --- |
| Another passenger's name, account id or contact details | The other member's row is never selected |
| Another passenger's ride-request id | Reachable only through their own request |
| Another passenger's pickup or destination | `myStops` is filtered by *their* request, so a co-passenger's stop is not read |
| Another passenger's fare | The fare read is keyed by their own request id |
| Another passenger's event history | `ride_events` is per request; a driver's `pool_events` are never read for a passenger |
| The event payloads behind any timeline | The mapper reads a fixed set of fields and `metadata` is not among them |

What *is* shared is aggregate: `passengerCount` and `vehicle.seatCapacity`. A count
cannot be unpacked into a person, and a passenger has a legitimate interest in both.
A passenger also sees `POOL_JOIN_ACCEPTED` as "someone joined your shared ride" —
the one event about another person that is included, because the passenger count
already discloses that a second person is in the car, and a shared-ride timeline
that silently omitted the second pickup would misdescribe the product.

For a driver the boundary runs the other way. A driver **must** see who they are
collecting and where, so a passenger appears with a first name, their two service
points and their own timestamps — and nothing else:

* no passenger account field, user id, email or credential;
* **no per-passenger fare.** The pool's fare is reported once, as a total, with no
  key that could attribute an amount to the person behind them;
* no passenger event history. The timeline is the **pool's**, mapped from
  `pool_events`;
* no other driver's data.

There is one asymmetry worth naming, because it looks like an inconsistency and is
not. A driver's **history** reports the pool's fare total; the pool they are
**currently** driving reports only whether the fare is settled, never an amount.
While a driver can still decide where to go next, what a passenger is paying must
not be part of that decision.

### Timelines are mapped, not dumped

`src/services/timeline.rules.js` is the single definition of **which internal event
a person may be told about, and what they are told**. It turns an
`event_type` into a sentence with a phase, and it is a whitelist:

* an event with no entry is **invisible**, so a milestone that adds an enum value
  gets an event nobody is told about until somebody decides what it means to whom;
* the whole dispatch family — `DRIVER_OFFERED`, `DRIVER_REJECTED`,
  `DRIVER_OFFER_EXPIRED`, `POOL_CANDIDATE_EVALUATED`, `POOL_JOIN_OFFERED`,
  `POOL_JOIN_REJECTED`, `INITIAL_DISPATCH_FALLBACK` — is absent for a passenger.
  `DRIVER_REJECTED` is the important one: telling a passenger that four drivers
  said no is a product decision nobody has made, and it is information about the
  drivers;
* `metadata` and `actorUserId` are never read, so an audit payload has no path into
  a response;
* the order is `sequence`, then timestamp, then id — deterministic even for a list
  assembled from more than one source.

### Pagination, filters and the tie-breaker

Both list endpoints use the project's existing envelope — `limit` + `offset` with
`pagination: { limit, offset, returned, total, hasMore }` — ordered newest first,
with the id appended:

```text
ORDER BY requested_at DESC, id DESC     (a passenger's rides)
ORDER BY created_at DESC, id DESC       (a driver's pools)
```

The tie-breaker is not cosmetic. Two rows written in the same millisecond have no
inherent order, so without it a client paging through them can see one twice and
miss another. With it the order is total, and page N+1 starts exactly where page N
stopped. The test suite proves it by writing three rows with an *identical*
timestamp and walking the pages twice.

`?status=` is validated against the real enum, so a typo is a `400` rather than an
empty page that looks like "you have never ridden". `?from=` and `?to=` are an
inclusive range of ISO instants. The driver's range filters `createdAt` rather than
`completedAt`, because `completedAt` is null on the pools a driver cares most
about — the ones still running; "finished trips in a range" is
`?status=COMPLETED&from=…&to=…`.

### Indexes

`server/db/13-read-api.sql` adds four indexes, and nothing else — the read APIs
needed no new state:

| Index | Serves |
| ----- | ------ |
| `ride_requests_passenger_status_requested_at_idx` | The passenger's history, with and without `?status=` |
| `ride_pools_driver_created_at_idx` | The driver's history, newest first, carrying the `id` tie-breaker |
| `ride_pools_driver_status_created_at_idx` | The driver's history filtered by status |
| `ride_pools_driver_completed_at_idx` (partial) | The driver's history filtered by a completion range |

They are ascending, and a btree index is read backwards at almost no cost, so an
index on `(passenger_profile_id, status, requested_at)` serves
`ORDER BY requested_at DESC` exactly as well as a `DESC` index would — and unlike
one, Prisma can express it, so `migrate diff` stays clean.

### Driver availability in one call

`PATCH /drivers/me/availability` is the toggle a driver app binds to:

```text
{ online: true,  servicePointCode | servicePointId, vehicleId? }  -> AVAILABLE
{ online: false }                                                 -> OFFLINE
```

It is **not** a second implementation of going online: it calls the same two
operations the dedicated endpoints do, so the state machine, the lock order and
every refusal are shared rather than duplicated. The response carries the boolean a
switch binds to (`online`), the state machine's own value under the name the
documentation uses (`operationalStatus`), and the place the driver is
(`servicePoint`, with the id a client sends back).

`operationalStatus` is deliberately **not accepted** in the body — sending it is a
`400`, not a silent no-op. A client may say "I am online" or "I am offline"; it may
never say "I am `ON_RIDE`". `RESERVED` and `ON_RIDE` are established by accepting an
offer and departing for the first pickup, and a device that could set them could
make itself dispatchable while carrying a passenger, or invisible while committed
to one.

Going offline is refused for `RESERVED` and `ON_RIDE` for the mirror-image reason:
a passenger is waiting for that car. The service point is *kept* across going
offline — it is where the driver is, and where they will come back from. Being
offline is not the same as being nowhere; the `OFFLINE` status is what removes a
driver from the dispatch search.

### Performance, and how it is proven

A history page costs a fixed number of queries whatever its size. The three
non-obvious pieces of that:

* the page query resolves the two service points, the member, the pool, its
  vehicle and its driver **inside one `findMany`**, so a page of one and a page of
  a hundred issue the same statements;
* every ride's shared fare is read in **one query for the whole page**, not one per
  row — and a page with no rows skips it entirely;
* the driver's summary reads no member rows at all: `passengerCount` comes from an
  aggregate, so paging back through every passenger a driver has ever carried is
  not a request that exists.

`test/integration/passenger-read-api.integration.test.js` proves this by **counting
queries**, not by checking the JSON: Prisma emits `query` events under
`NODE_ENV=test`, and the suite asserts that a page of ten costs exactly what a page
of one costs. A per-row query would produce identical output and a growing count,
which is exactly the bug a shape-based test cannot see.

A note on the absolute number, because it is not small: Prisma resolves each nested
relation with its own statement rather than joining, so a "handful of queries" here
means roughly a dozen. The property that matters — and the one the tests pin — is
that the number is bounded by the *shape of a ride* rather than by how many rides
were asked for.

### Commands

```bash
npm run db:migrate      # applies 13-read-api.sql (idempotent, safe to re-run)
npm test                 # unit + integration
npm run test:unit --workspace server         # the rules and the DTOs, with no database
npm run test:integration --workspace server  # the reads over HTTP, the ownership, the query counts
curl localhost:4000/api/docs                 # the OpenAPI document
```

### What is deliberately not here

**No passenger cancellation, no driver cancellation, no no-show handling, no
payments or refunds, no live GPS, no WebSockets or notifications, no ratings, no
admin workflows and no frontend code.** The read APIs add no write of their own:
`POST`, `PUT`, `PATCH` and `DELETE` against a read path are `404`, and a test
asserts it.

Two limitations worth naming. Everything is **polling**: there is no push, so a
client learns about a pickup by asking, and the honest interval is a few seconds.
And the read APIs report the plan rather than the road — an arrival is a stop being
marked `ARRIVED`, never a verified position, until a GPS milestone makes that a
claim rather than a statement.


## The passenger's app

The first frontend milestone: the **passenger** half of the product, end to end. Sign
in, choose two places, see a price, request the ride, and watch it.

```bash
npm run db:up
npm run db:migrate
DEMO_SEED_PASSWORD='<pick one>' npm run db:seed   # creates the demo accounts
npm run dev                                       # API on :4000, client on :3000
```

| Screen | URL | What it does |
| ------ | --- | ------------ |
| Redirect | `/` | A passenger goes to `/ride`; anybody else to `/signin`; an unreachable API to `/status` |
| Sign in | `/signin` | `POST /auth/login` — signed-in passengers are redirected on |
| Sign up | `/signup` | `POST /auth/register` with `role: PASSENGER` — creates the account *and* signs in |
| Request | `/ride` | `GET /location/zones`, `GET /location/points`, `POST /fare-quotes`, `POST /ride-requests` |
| Track | `/track` | `GET /passengers/me/current-ride`, polled every 5 seconds |
| Status | `/status` | The scaffold's diagnostics page: health, database latency, and the seeded accounts |

### The five rules the client is built on

1. **Nothing takes a user id.** There is no user picker and no passenger id in any
   body: the HttpOnly cookie identifies the caller and every `/me` path resolves it
   on the server.
2. **The request is quote-first.** `POST /fare-quotes` returns an immutable quote the
   passenger owns; `POST /ride-requests` is created *from* it and takes only
   `{ fareQuoteId }` plus a required `Idempotency-Key` header (8–128 characters).
   The key identifies one **intent**, not one attempt — a retry that generates a fresh
   key creates a second ride.
3. **The screen submits the quote it is showing.** A quote is priced at an instant by
   a traffic profile, so quoting again at submit time can return a different number
   from the one on screen. The panel therefore quotes once, keeps the `quoteId`, and
   submits it. `requestRide()` in the API layer — which quotes and requests in one
   call — is deliberately *not* used by a screen that has already displayed a price.
4. **No rule is re-implemented.** `stage` and `nextAction` are computed on the server
   from the ride's own timestamps; the client renames them for display. There is no
   `if (status === "MATCHED" && !departedAt)` anywhere, no fare arithmetic, and money
   stays the exact decimal string the API sent (`Number("59.78")` is a binary float
   and is how a paisa goes missing).
5. **The guard runs on the server.** `src/lib/session.js` resolves the session while
   the page renders, so protected markup is never shipped to a browser that should
   not see it. No `page.js` is a client component; only the pieces that collect input
   or poll are.

### Tracking is polling, and stops when the ride does

There is no push in this project, so the tracker asks. The interesting part is how:

* A **recursive `setTimeout`**, not `setInterval` — an interval lets a slow request
  stack up behind the next tick, so the screen shows the answer to a question asked
  four polls ago.
* **It stops when the ride is over.** `GET /passengers/me/current-ride` answers with
  an *active* ride (`WAITING`, `MATCHED`, `IN_PROGRESS`) or `200 { ride: null }`. A
  ride that reached `COMPLETED` or `CANCELLED` therefore arrives as `null` and there
  is nothing left to poll for.
* **A hidden tab pauses**, and re-checks the moment it becomes visible.
* **A failed poll keeps the last good ride** and says the update failed, because the
  API being briefly unreachable is not the same as the ride disappearing.

`null` does **not** say which way the ride ended, so the tracker asks
`GET /passengers/me/rides/:id` the moment it happens — see
[Driving the ride](#driving-the-ride) — rather than guessing from an absence.

### Calling a ride off

While a request is still waiting for a driver, the passenger can cancel it:

```
POST /ride-requests/:id/cancel    { reason? }
```

`reason` is one of `CHANGED_MIND`, `WRONG_LOCATION`, `WAIT_TOO_LONG` or `OTHER`, and
defaults to `OTHER`. Calling it also withdraws any dispatch offer outstanding for
that ride, in the same transaction: a driver who was being asked about it is told it
is gone rather than left answering a question that no longer has an answer.

**It is allowed in exactly one state, and the client does not decide that.** The rule
is the state machine's — `WAITING -> CANCELLED` is a transition, `MATCHED -> CANCELLED`
is not — and the ride DTO publishes its answer as `cancellable`, computed by
`isCancellable(status)`, which is `status === "WAITING"`. So the screen renders the
control from that flag rather than from a status it would have to interpret.

That distinction is not pedantry. A hand-written `status === "WAITING"` gives the same
answer today and a worse one the moment the rule changes: the two versions drift, and
the copy in the browser silently stops offering a cancel the server would allow — or
offers one it will refuse. Rendering from the flag also means the button cannot be
*wrong*, because the endpoint that would refuse the call is the one that set it.

Two consequences that are handled rather than ignored:

* **a `409` is not a failure.** It means a driver accepted in the moment between the
  passenger opening the form and confirming, so the screen says exactly that instead
  of "could not cancel", and the next poll re-renders without the control;
* **after a success there is no new screen.** The tracker sets the ride to `null` and
  reuses the terminal path it already had: the ride detail reports `CANCELLED`, the
  reason is recorded, and polling stops.

Verified end to end, from both directions:

| Ride state | Cancel control | Direct API call |
| ---------- | -------------- | --------------- |
| `WAITING` | offered | `200`, ride becomes `CANCELLED` |
| `MATCHED` | **absent** | `409` — the server refuses it |

### What is deliberately not here

**No driver screens, no pooling screens, no history screen, no map, no realtime
socket, no driver-side cancellation, no payment and no admin workflow.** The server
supports all of them; this client calls only the endpoints it needs. Two of those
limitations were closed by later milestones — see
[The driver's console](#the-drivers-console) and [Driving the ride](#driving-the-ride)
— and the rest still stand.

One limitation worth naming: the cancellation **reason is recorded but not shown
back**. `findRideForPassenger` reads the column, and `toRideRequestDto` publishes it,
but the ride *detail* DTO does not — so the finished screen says the ride was
cancelled without echoing why. Adding it to the detail DTO is a one-line change plus a
test, and belongs with the history milestone that will display it.

Two more honest limitations. The client has **no test suite** — `npm run lint` and
`npm run build` are its automated checks, and the server's 1123 tests are what pin
the contract it renders. And `GET /api/users` is still public and unauthenticated,
kept that way so `/status` can list the seeded accounts.


## The driver's console

The other half of the loop. A passenger asks for a ride, a driver is offered it,
answers it, and the passenger's screen changes from *finding a driver* to *waiting
for a driver* — with a name and a car on it.

```text
Passenger creates a WAITING ride request
  -> the dispatcher shortlists nearby AVAILABLE drivers and routes them to the pickup
  -> the best candidate gets one DispatchOffer, which expires in 30 seconds
  -> the driver's console polls its offers and shows it
  -> accept  ->  a pool, and the passenger's current ride becomes MATCHED
  -> decline ->  the request stays WAITING and the next driver is offered it
```

| Screen | URL | What it does |
| ------ | --- | ------------ |
| Sign in | `/signin` | One form for both roles; the role decides where you land |
| Console | `/driver` | `GET /drivers/me/availability`, `GET /drivers/me/offers`, `GET /drivers/me/current-pool`, `PATCH /drivers/me/availability` |
| Answer | — | `POST /drivers/me/offers/:id/accept` (no body) and `…/reject` with a reason |

You need a driver with a vehicle to try it. The seed creates one — sign in as
`jashim@example.com` with the password from `DEMO_SEED_PASSWORD` — and come online at
a point near the passenger's pickup (Banani Kakoli is 445 m from Banani Road 11;
Gulshan 2 Circle is 1068 m in a straight line but 3.1 km by road).

### Four things this slice had to get right

1. **One client, two roles.** A person signs in before they are a passenger or a
   driver: the API has one login endpoint, one cookie and one DTO, and the role only
   matters once it has answered. Someone signed in as the *other* role is redirected
   to their own home rather than to the sign-in form — a signed-in driver sent to
   `/signin` would fill it in and be sent straight back, which is a loop.
2. **The offers list *is* the heartbeat.** `last_seen_at` is refreshed when a driver
   goes online, moves, **reads their offers**, or answers one. A location older than
   `DISPATCH_LOCATION_FRESHNESS_SECONDS` (300 s) makes them ineligible, so a console
   that stops polling quietly drops its driver out of dispatch. It therefore polls in
   a background tab too, at 30 seconds instead of 5 — and not at all while offline.
   (The passenger's tracker does the opposite in a background tab, because a ride
   nobody is looking at has nothing to keep current. The two are the same hook with
   different cadences.)
3. **Nothing is derived in the browser.** `canGoOnline`, `canGoOffline` and an
   offer's `expired` come from the API. They are not opposites: a `RESERVED` driver is
   online and may still not go offline, because they have accepted a passenger.
   Where a screen has to choose *which control to draw* it uses the published
   `online` boolean, not a status it would have to interpret.
4. **Accepting sends no body.** The plan is the one stored when the offer was made, so
   there is nothing to submit and nothing to edit — the endpoint posts an offer id and
   returns the pool. An offer that belongs to another driver is a `404`, the same as
   one that does not exist.

### What is deliberately not here

**No trip execution.** The console shows the pool the driver has just accepted —
who, from where, to where, in what order — and `allowedActions` in words, but no
buttons. Departing, arriving, collecting, starting, dropping off and completing are
the next milestone, and drawing a control for them now would mean either wiring five
commands this milestone does not own or drawing a button that does nothing.

**No driver sign-up.** The API accepts `role: DRIVER` on `POST /auth/register`, but
a new driver starts `OFFLINE` with no vehicle, and **no endpoint in this project
creates one** — so such an account can sign in and cannot be dispatched to. The
console says that plainly when it happens, rather than offering a switch that would
`409` every time.

**No "move me" control.** `PUT /drivers/me/current-service-point` exists and is valid
while a driver is offline or available, but the availability DTO publishes no boolean
for it. Working it out from `status` would be a second copy of
`canSetCurrentServicePoint`, so a driver who wants to relocate goes offline and comes
online somewhere else — two clicks, and no new rule.

### The bug this slice found in the server

The API's own OpenAPI document listed the ride-cancellation reasons as
`CHANGED_MIND`, `FOUND_OTHER_RIDE`, `WAITING_TOO_LONG` and `OTHER`. The endpoint
accepts `CHANGED_MIND`, `WRONG_LOCATION`, `WAIT_TOO_LONG` and `OTHER` — so a client
written against the published contract got a `400`. `openapi.yaml` is corrected; the
unit suite only checked paths, not enum values, which is why it had gone unnoticed.


## Driving the ride

The last piece of the loop: an accepted ride, driven to the end. The passenger's
screen follows it without being told anything — the driver presses a button, and the
tracker's next poll reports the new stage.

```text
Driver accepted
  -> set off            passenger: driver on the way
  -> arrive at pickup   passenger: driver has arrived
  -> collect            passenger: you are in the car
  -> start the trip     passenger: trip in progress
  -> arrive at dropoff  (no stage change: the passenger is already in the car)
  -> drop off           passenger: ride completed, with the fare and the timeline
  -> complete           driver released, back to AVAILABLE
```

| Screen | URL | What it does |
| ------ | --- | ------------ |
| Console | `/driver` | The pool in progress: the ordered plan, the passengers, and one button per allowed action |

The commands are `POST /drivers/me/pools/:poolId/{depart,start,complete}` and
`…/stops/:stopId/arrive` / `…/stops/:stopId/members/:memberId/{pickup,dropoff}`. Every
one takes **no body** — the identifier is in the path, and there is nothing a client
could usefully add. Idempotency is state rather than a key: sending the same command
twice returns the state it produced the first time, with no second event and no
timestamp moved, so a retry after a timeout is safe.

### Where the buttons come from

**`allowedActions` arrives with the pool, and each entry becomes one button.** That is
the whole design: the server computes the six commands' preconditions with the same
rules the commands themselves consult, so the client cannot offer an action that would
be refused, and cannot hide one that is legal.

Two things this gets right that a hand-written state machine would not:

* **The list is not one action per status.** Immediately after collecting a passenger
  the server allows **two** commands at once — `ARRIVE_AT_STOP` *and* `START_TRIP` —
  because the driver may either reach the drop-off or begin the journey proper. A
  screen that rendered "the next action" would silently drop one of them.
* **An action that already succeeded is absent, not disabled.** The server omits a
  command whose decision is "repeat", because there is nothing left to do about it.
  A greyed-out button would be inventing history.

`nextStop` is where the actions point — "the lowest-sequence stop that is not done, and
the only stop they may serve" — so the label ("Pick up **Nusrat**", "Arrive at
**Mohakhali Bus Terminal**") and the request cannot disagree about which stop or which
passenger is meant. The wording comes from `driver-status.js`; the permission came from
the server.

Observed at each step of a real run:

| After | Pool | `allowedActions` | Passenger `status` / `stage` |
| ----- | ---- | ---------------- | ---------------------------- |
| accept | `FORMING` | `[DEPART]` | `MATCHED` / `DRIVER_ASSIGNED` |
| set off | `DRIVER_EN_ROUTE` | `[ARRIVE_AT_STOP]` | `MATCHED` / `DRIVER_EN_ROUTE` |
| arrive | `ARRIVED` | `[PICKUP_PASSENGER]` | `MATCHED` / `DRIVER_ARRIVED` |
| collect | `ARRIVED` | `[ARRIVE_AT_STOP, START_TRIP]` | `MATCHED` / `PICKED_UP` |
| start | `IN_PROGRESS` | `[ARRIVE_AT_STOP]` | `IN_PROGRESS` / `IN_PROGRESS` |
| arrive | `IN_PROGRESS` | `[DROPOFF_PASSENGER]` | `IN_PROGRESS` / `IN_PROGRESS` |
| drop off | `IN_PROGRESS` | `[COMPLETE_TRIP]` | `COMPLETED` / `RIDE_COMPLETED` |
| complete | `COMPLETED` | `[]` | `COMPLETED` / `RIDE_COMPLETED` |

### How the passenger's screen learns it finished

`GET /passengers/me/current-ride` answers with an **active** ride or nothing, so a
finished ride arrives as `null` — and that response does not say whether the passenger
arrived or was cancelled on. The tracker therefore asks a second question the moment
the active ride disappears: `GET /passengers/me/rides/:id`, which has no status filter
and reports the API's own `COMPLETED` or `CANCELLED`.

That is the difference between reporting and guessing. The screen previously inferred
"completed" from a drop-off timestamp on the last active read — usually right, and
still a claim about somebody's money built out of an absence. It now shows the real
status, the request's own `completedAt`, the fare, and the nine-event timeline the
passenger is allowed to see. Polling stops at that point: there is nothing left to
learn.

### What is deliberately not here

**No driver-side cancellation.** A driver cannot call off a ride they have accepted,
and a passenger cannot call off one that has been matched — the API refuses both. (A
passenger *can* cancel while the ride is still waiting; see
[Calling a ride off](#calling-a-ride-off).)

**No history.** Both roles have read APIs for the rides they have finished
(`/passengers/me/rides`, `/drivers/me/rides`) and neither has a screen.

**No location the server can verify.** "Arrive at stop" is the driver *saying* they
arrived — there is no GPS, and the API records the claim rather than checking it. So
the timeline says "Your driver arrived at your pickup" because the driver pressed a
button, which is honest for this MVP and is the thing a GPS milestone would change.

**No payment.** A fare is settled by departure and reported to the passenger; nothing
collects it.

### The bug this slice found in the server

**`nextStop` was serialized from the wrong shape.** `toPoolDto` picks the next stop with
`nextActionableStop(...)` — but it was passing it the *rule-shaped* stops from
`toRuleContext`, which carry only the four fields the rules read. The DTO's
`nextStop` therefore had `servicePoint: null` and no planned arrival, while the
identical row in `stops[]` named the place all along. A driver's screen could not say
which stop it was about to arrive at.

The fix matches the decision to the loaded row by id, so the *choice* still comes from
the rules and the *data* comes from the row. The unit test had asserted only
`nextStop.stopId` and `nextStop.stopType`, which is why it survived; it now compares
`nextStop` field by field against the same stop in `stops`.


## Tests

```bash
npm test                        # everything
npm run test:unit --workspace server
npm run test:integration --workspace server
```

Tests use Node's built-in runner (`node --test`) — no extra dependencies. The integration suites run against the real PostgreSQL database from `DATABASE_URL`, apply `server/db/*.sql` and the seed themselves, and clean up after themselves; the database must be reachable (`npm run db:up`). Constraint tests run inside rolled-back transactions.

Coverage highlights: the PostGIS extension and the real spatial column types; the GiST spatial indexes; that coordinates are stored longitude-first; `ST_DWithin` proximity answering in metres with a distant point correctly excluded; the seed totals, per-zone point counts, correct zone membership and idempotency; the coordinate bounds; and -- for the graph -- no isolated vertex, one weakly connected component, every zone linked to another, edge endpoints aligned with their vertices, edge distance matching `ST_Length`, and the direction / duration / fare-weight invariants. It also asserts that the superseded `/api/transport/*` endpoints are gone, and that `/api/location/*` still exposes no routing of its own. Routing, pricing, ride requests, dispatch, shared matching, shared fares, the driver's trip and the read APIs are covered by their own suites -- see [Routing](#routing), [Fare quotes](#fare-quotes), [Ride requests](#ride-requests), [Driver dispatch and pools](#driver-dispatch-and-pools), [Pool-first shared matching](#pool-first-shared-matching), [Shared fares](#shared-fares), [The driver's trip](#the-drivers-trip) and [Reading a ride](#reading-a-ride) for the lists.

Each milestone's suite also pins the boundary of the next one: the fare suite asserts which tables exist and that nothing shared, seated or paid does, and the matching suite asserts that no shared fare and no trip operation is reachable, and that a pool that has started is never matched into. The shared-fare suite pins the same boundary one step further on: no payment, wallet, payout or settlement endpoint exists, and a fare is never finalized. The trip suite pins the last of it: no payment, wallet, payout or settlement endpoint is reachable, no passenger-side pick-up, drop-off or completion exists, and after a whole journey the counts of cancelled pools, skipped stops and cancelled or no-show members are all still zero.

The matching suites are split the way the rules are. `test/unit/matching.rules.test.js` covers insertion positions, stop orders, occupancy, arrival arithmetic, the limits, scoring and the full tie-break, with a fixture whose distances are literal metres so the numbers can be checked by hand. `test/integration/matching.integration.test.js` covers the candidate query and its exclusions, the PostGIS shortlist and what proximity does *not* buy, the offer lifecycle over HTTP, the acceptance transaction, and the races -- including a pool's last seat contended by two requests at once.

The trip suites are split the same way. `test/unit/trip.rules.test.js` covers, with no database at all, the departure requirements, the stop order (including why a shared corner is two consecutive stops and neither can be skipped), every arrival, pickup, start, drop-off and completion requirement by name, the three decisions and the order they are asked in, the passenger stages, the passenger's next action, and `allowedActions` offering an action exactly when its own decision would be `APPLY`. `test/integration/trip.integration.test.js` drives the whole lifecycle over HTTP against the real database: ownership (another driver's pool is a `404` on all six endpoints, a passenger's is a `403`), departure and what it closes and freezes, the stop-order refusals, arrival, collecting at a shared corner, starting with a later passenger still `MATCHED`, per-passenger completion while the pool carries on, completion and the driver's release, retries (asserting by `deepStrictEqual` that no timestamp and no event moved), two commands at once, and what the passenger sees -- including that their `trip` block leaks nobody else's plan.

The read-API suites are split the same way again. `test/unit/timeline.rules.test.js` pins the event mapper -- every dispatch event invisible to a passenger, every ride event invisible to a driver, an unknown event type invisible to everybody, and an entry's keys fixed so a payload cannot creep in. `test/unit/passenger-ride.serializer.test.js` and `test/unit/driver-ride.serializer.test.js` assert each DTO's exact key set against fixtures that *carry* the fields they must not publish (a co-passenger's email, a fingerprint, a per-passenger fare), so a serializer that started reading one fails rather than leaking. `test/unit/openapi.test.js` reads the route files and asserts that `openapi.yaml` documents every path the router mounts and no path it has stopped mounting -- the drift that actually happens to a spec. The integration suites then drive real pools over HTTP: `passenger-read-api.integration.test.js` covers the current ride, the history, the detail, ownership between two passengers who have really ridden, filters, pagination stability with equal timestamps, timeline privacy against the real `ride_events` rows, and **counts the queries Prisma issues** to prove a page of ten costs what a page of one costs. `driver-ride-history.integration.test.js` covers the same ground for a driver, with two drivers and their own pools: ordering, the shared-corner plan, pool fare totals with no per-passenger amount, another driver's pool as a `404`, and that an offline driver is left out of the dispatch search until they come back online.

One fixture rule the trip milestone imposed on the older suites is worth recording, because it was the source of a suite-wide failure that looked like a bug in the code: a pooled fare is priced at the instant the plan changes, and a passenger's detour is measured against the duration **their own quote** froze. A fixture that pins a quote's departure to a fixed hour therefore prices it under whatever traffic profile that hour carries, while the detour is measured *now* -- so the same fixture passes at noon and fails at 17:00. Every fixture that creates a quote and then joins a pool now quotes at `new Date()` (`planNow()` in the matching, fare and trip suites), which is what a real passenger does.

The shared-fare suites are split the same way. `test/unit/pool-fare.rules.test.js` covers who is on board for which leg, what a leg costs, how a leg is split and how the residual units are handed out, the two caps and the minimum fare's precedence, and the totals identity -- all with amounts that can be checked by hand, and with an exhaustive split table asserting that shares sum to the leg cost for every amount and every passenger count. `test/integration/pool-fare.integration.test.js` covers the ledger: one CURRENT calculation per pool and one per plan version, superseding rather than overwriting, the write-once and append-only triggers, idempotent recalculation, a stale version refused with a `409`, a join rolled back when the pricing is broken, two recalculations racing to one answer, the two protections biting when a policy changes mid-pool, and the passenger API's privacy. Between them they name the milestone's numbered categories `1`--`42` and `44`--`46`; category `43` -- that the authentication, routing, fare, request, dispatch, pool and matching suites still pass -- is the `npm test` gate itself, and the two suites that would break it are the ones they changed.

The frontend milestones add **no tests of their own**, and that is deliberate rather than unfinished: the client is JavaScript with no test runner, and everything it renders -- the quote, the `stage`, the `nextAction`, `canGoOnline`, an offer's `expired`, the DTO's exact field set -- is pinned by the server suites those sections describe. What the client *is* checked by is `npm run lint` (ESLint with the Next config) and `npm run build` (a real Next build, which fails on an unresolved import, a client component that imported the server-only guard, or a page that used a synchronous `cookies()`), plus the full server suite, which must stay green because the client renders its answers.

## Next steps

- Decide how schema changes are reviewed now that Prisma is in place: keep the idempotent `server/db/*.sql` files as the source of truth (the current setup, and what preserves the `CHECK` constraints, the partial unique index and the GiST indexes Prisma cannot model), or move fully to Prisma Migrate and express those another way.
- Build the trip on top of matched pools: driver arrival, trip start, passenger pickup and drop-off, trip completion. *Done -- see [The driver's trip](#the-drivers-trip).* The transitions (`MATCHED -> IN_PROGRESS -> COMPLETED`, `ASSIGNED -> PICKED_UP -> DROPPED_OFF`, `FORMING -> DRIVER_EN_ROUTE -> ARRIVED -> IN_PROGRESS -> COMPLETED`) and the events are implemented end to end, the pool is closed to matching by its own departure, and the fare is frozen in the same transaction.
- Settle the fares once that trip exists. *Done -- departure finalizes the pool's `CURRENT` `pool_fare_calculations` row (`status = FINALIZED`, `finalized_at`), and a ride cannot start under an unfinalized fare.* A *second* rule version is still what a post-trip adjustment would need, because a settlement that silently changed `pool-leg-share-v2`'s answer would be a re-pricing of money already owed.
- Decide what a cancellation inside a matched pool costs. Cancelling a matched request is refused today, which is the honest answer while a pool has no trip and no money has changed hands; once fares are charged, a cancellation needs a policy (who keeps the seat, what the remaining passengers are charged, whether a fee applies) before it needs code. `passenger_fare_allocations.previous_pooled_fare_cap` is where the remaining passengers' ceilings would come from. The same milestone is what would close a journey a driver abandoned: today a pool that is never completed stays `IN_PROGRESS` and its fare stays `FINALIZED`, with no operation that could end it.
- Prove where the driver is. The trip records that a driver reached a stop and never checks that they were there; a GPS milestone is what would make the arrival a claim rather than a statement, and it would need a tolerance policy and an "the driver is not moving" rule before it needed code.
- Charge and pay out. Nothing collects money or pays a driver, and a fare is a number until a payment milestone decides otherwise; the ledger is deliberately shaped so that settlement is a new operation over existing rows rather than a change to how fares are calculated.
- Run the sweeps on a schedule. `npm run ride-requests:expire --workspace server` and `npm run dispatch:sweep --workspace server` are the operations; nothing calls them yet, so requests and offers are cleaned up when someone runs them.
- Consider time-dependent profiles *within* a journey (the current router picks one profile from the departure instant and applies it to the whole route), which needs per-second costs and a time-dependent router.
- Authenticate the client: send the auth cookie from the Next.js app, then tighten `GET /api/users`, which is still public so the demo page keeps rendering. *Half done -- the client carries the cookie and every passenger screen is guarded on the server; `GET /api/users` is still public, and `/status` is why.* `POST /api/routes/estimate` already requires a session, so the client needs to carry the cookie before it can call it.
- Add email verification and password reset. Sign-up currently accepts any address a caller supplies, so nobody proves they own the email they register with.
- Rate-limit `POST /api/auth/login` and `POST /api/auth/register`. No limiter is installed yet, so password guessing and bulk sign-ups are unthrottled.
- JWT logout cannot revoke a token before it expires. Add a token denylist (or move to opaque server-side sessions) if immediate revocation becomes a requirement.
- Add validation (e.g. `zod`) for request bodies once write endpoints exist.
- Add Playwright coverage for the client. It has none today: `npm run lint` and `npm run build` are its only automated checks, and every behaviour it renders is pinned indirectly by the server suites.
