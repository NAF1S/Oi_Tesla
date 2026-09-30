# TeslaB

A ride-pooling demo in the shape of a real product: passengers request rides between
named places in Dhaka, drivers are offered those rides one at a time, and a car can
carry more than one passenger — with each of them billed a share of the legs they
actually rode.

The two halves are a **Next.js 16** client and an **Express 5** API over **PostgreSQL
17 + PostGIS + pgRouting**. Distances and durations are real routed measurements over a
seeded road graph, not straight-line guesses, and every fare is a row of exact decimals.

The whole domain lives on the server. The client renders what the API publishes — it
never decides that a ride may be cancelled, that an offer has expired, or that a fare
is owed. There is no payment gateway, no GPS and no push notifications; see
[Known limitations](#known-limitations).

---

## Table of contents

- [Summary](#summary)
- [Problem statement](#problem-statement)
- [Features implemented](#features-implemented)
- [Architecture](#architecture)
- [Database / ERD](#database--erd)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Environment variables](#environment-variables)
- [Local setup](#local-setup)
- [Docker](#docker)
- [Migrations and seeding](#migrations-and-seeding)
- [Running the apps and the tests](#running-the-apps-and-the-tests)
- [Demo credentials](#demo-credentials)
- [Deployment](#deployment)
- [API overview](#api-overview)
- [Key decisions and trade-offs](#key-decisions-and-trade-offs)
- [Concurrency and data consistency](#concurrency-and-data-consistency)
- [Scaling to 1M passengers and 100k drivers](#scaling-to-1m-passengers-and-100k-drivers)
- [Known limitations](#known-limitations)
- [Next improvements](#next-improvements)
- [AI usage](#ai-usage)
- [Demo video](#demo-video)

---

## Summary

|                      |                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| **What it is** | A ride-pooling demo: request a ride, get matched with a driver, share the car, split the fare, pay. |
| **Client**     | Next.js 16 (App Router, JavaScript, Tailwind v4)                                                    |
| **API**        | Express 5, ESM, Node ≥ 20                                                                          |
| **Data**       | PostgreSQL 17 + PostGIS 3.5 + pgRouting 3.8, 24 tables                                              |
| **Routing**    | Real graph search (`pgr_dijkstra`) over a seeded Dhaka road network                               |
| **Money**      | Exact decimals end to end; a JavaScript`number` is refused                                        |
| **Tests**      | `node --test`, unit + integration against a live database                                         |
| **Deploy**     | One`docker compose up`, or the split described in [Deployment](#deployment)                        |

## Problem statement

A single-passenger taxi app has one hard part: matching a request to a driver. A
**pooling** product has four, and they pull against each other:

1. **Deciding whether two journeys can share a car.** Two passengers going the same
   way can share; two going opposite ways waste each other's time. That decision has to
   be made *before* anyone commits, and it must be explainable to the driver who is
   being asked to make the detour.
2. **Pricing the share fairly.** A pooled fare must never cost a passenger *more* than
   the solo trip they were quoted — otherwise pooling is a punishment — and the sum of
   the shares has to be defensible against the distance actually driven.
3. **Keeping the timeline honest.** Who was picked up, when, and on whose authority.
   In a money-carrying system "we think this happened" is not good enough, and a
   retried request must not write the event twice.
4. **Not trusting the client.** Every one of these rules is money or safety. If the
   browser is allowed to decide when a ride may be cancelled or how much a fare is, the
   browser is part of the security boundary.

The demo answers all four by putting the rules in one place — pure, unit-tested modules
that the services, the SQL constraints and the tests all share — and having the API
publish its decisions as facts (`allowedActions`, `nextAction`, `payable`) that a client
renders rather than recomputes.

## Features implemented

**Passenger**

- Sign up / sign in; an HttpOnly session cookie, never a token in JavaScript.
- Browse service points grouped into zones and ask for a fare quote between two of them.
- Request a ride from a quote (idempotent — a retried submit does not create two rides).
- Watch the ride live: the driver's name and car, the two stops, the fare, and a
  timeline of what happened.
- Cancel a request while the server still allows it, with a reason.
- Ride history and per-ride detail, as a projection rather than a loop.
- **TeslaPay** — settle a completed fare from a wallet balance or in cash.

**Driver**

- Go online at a service point and go offline again, with the server deciding which of
  those is currently possible.
- Receive offers **one at a time**, each with the plan, the metrics that justify it, and
  an expiry.
- Accept (no request body — the plan that was stored is the plan that is accepted) or
  decline.
- Drive the trip: set off, arrive at a stop, pick up, start, drop off, complete — in the
  order the plan stores and no other.
- See the current pool, its stops and its passengers; see past pools driven.
- See earnings, outstanding fares and a TeslaPay balance.

**System**

- Ride matching with a written, versioned rule set (`pool-match.v2`).
- Shared-fare pricing: per-leg cost, split by who was aboard for that leg, capped so
  pooling never costs more than the solo quote.
- An append-only event timeline per ride request, and per pool.
- Idempotent, cumulative SQL migrations with the guarantees enforced as `CHECK`s,
  triggers and partial unique indexes — not only as service code.
- OpenAPI contract served at `GET /api/docs`, and a test that fails if a route is not
  documented.

## Architecture

```mermaid
---
title: TeslaB — system architecture
---
flowchart TB
    subgraph actors["Who uses it"]
        direction LR
        pax(["Passenger"])
        drv(["Driver"])
    end

    subgraph web["Next.js 16 client · localhost:3000"]
        direction TB
        screens["App Router screens<br/>/   /signin   /signup   /status<br/>/ride   /track   /driver"]
        guards["Server-side guards<br/>lib/session.js"]
        widgets["Client components<br/>poll for state changes"]
        apiClient["lib/api.js<br/>one fetch wrapper"]
    end

    subgraph api["Express 5 API · localhost:4000"]
        direction TB
        middleware["Middleware<br/>cors · json · cookies<br/>requireAuth · requireRole"]
        routeMods["10 route modules under /api"]
        controllers["Controllers"]
        services["Services — the domain"]
        pure["Pure rules modules (unit tested)<br/>ride.status · dispatch · matching<br/>pool.fare · trip"]
        orm["Prisma + adapter-pg"]
    end

    subgraph data["PostgreSQL 17 · PostGIS + pgRouting · localhost:55432"]
        direction TB
        tables["24 tables<br/>CHECKs · triggers · unique indexes"]
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

The source of this diagram is `docs/architecture.mmd`.

## Database / ERD

```mermaid
---
title: TeslaB — database (ERD)
---
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
    WALLET_ACCOUNTS {
        uuid id PK
        uuid user_id FK "unique"
        text currency
        numeric balance "never negative"
    }
    PAYMENTS {
        uuid id PK
        uuid ride_request_id FK "unique: payable once"
        uuid ride_pool_id FK
        uuid fare_calculation_id FK
        uuid payer_user_id FK
        uuid driver_user_id FK
        numeric amount
        text currency
        enum method "TESLA_PAY | CASH"
        enum status "PENDING | PAID"
        timestamptz paid_at
    }
    WALLET_LEDGER {
        uuid id PK
        uuid account_id FK
        uuid payment_id FK "nullable: outlives the payment"
        enum reason "PAYMENT | TOP_UP"
        enum direction "DEBIT | CREDIT"
        numeric amount
        numeric balance_after
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
    USERS ||--|| WALLET_ACCOUNTS : "holds one"
    WALLET_ACCOUNTS ||--o{ WALLET_LEDGER : "records"
    RIDE_REQUESTS ||--o| PAYMENTS : "settles"
    RIDE_POOLS ||--o{ PAYMENTS : "billed as"
    USERS ||--o{ PAYMENTS : "party to"
    PAYMENTS |o--o{ WALLET_LEDGER : "moves"
```

The source is `docs/erd.mmd`. The 24 tables fall into five bands:

| Band            | Tables                                                                                                                                                              | Added by                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Reference       | `service_zones`, `service_points`                                                                                                                               | locations                               |
| Routing         | `routing_vertices`, `routing_edges`                                                                                                                             | PostGIS / pgRouting                     |
| Pricing         | `fare_policies`, `fare_quotes`                                                                                                                                  | fares                                   |
| Ride & dispatch | `ride_requests`, `ride_events`, `dispatch_offers`, `ride_pools`, `pool_members`, `pool_stops`, `pool_events`                                          | ride requests, dispatch, matching, trip |
| Money           | `pool_fare_calculations`, `pool_fare_legs`, `passenger_fare_allocations`, `passenger_fare_leg_shares`, `wallet_accounts`, `payments`, `wallet_ledger` | shared fares, TeslaPay                  |

Identity (`users`, `passenger_profiles`, `driver_profiles`, `vehicles`) sits across all of
them.

`server/db/*.sql` is the source of truth for the schema. `server/prisma/schema.prisma` is
a **mirror** for the Prisma client, not an owner — `prisma migrate` is deliberately not
used, because it would try to take ownership and drop the `CHECK` constraints it cannot
model.

## Tech stack

| Layer    | Choice                                            | Why                                                                              |
| -------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Client   | Next.js 16.3.5, React 19.2.8, JavaScript          | App Router; JSDoc typedefs instead of TypeScript                                 |
| Styling  | Tailwind CSS v4                                   |                                                                                  |
| Lint     | ESLint 9 +`eslint-config-next`                  |                                                                                  |
| API      | Express 5.1, ESM                                  | Node ≥ 20                                                                       |
| ORM      | Prisma 7.10 +`@prisma/adapter-pg`               | The only database path; raw SQL where a row lock or a routing function is needed |
| Auth     | `jsonwebtoken`, `bcryptjs`, `cookie-parser` | Signed JWT in an HttpOnly cookie                                                 |
| Database | PostgreSQL 17, PostGIS 3.5, pgRouting 3.8         | `pgr_dijkstra` / `pgr_withPoints` for real routed distances                  |
| Tests    | `node --test`                                   | No test framework dependency                                                     |

## Project structure

```
.
├── client/                     Next.js 16 — both halves of the loop
│   └── src/
│       ├── app/                /  /signin  /signup  /status  /ride  /track  /driver
│       ├── components/         passenger/, driver/, payment/, auth/, shared UI
│       └── lib/                api.js (one fetch wrapper), session.js, *-api.js, types.js
├── server/                     Express 5 — all the domain rules
│   ├── db/                     NN-*.sql — idempotent migrations, the schema's source of truth
│   ├── prisma/schema.prisma    The Prisma mirror of that schema
│   ├── openapi.yaml            The API contract, served at GET /api/docs
│   └── src/
│       ├── routes/             One module per area, mounted under /api
│       ├── controllers/        HTTP in, DTO out
│       ├── services/           The domain, plus *-rules.js pure modules
│       ├── serializers/        Whitelist DTOs
│       └── middleware/         requireAuth, requireRole, error handling
├── docs/                       architecture.mmd, erd.mmd (the diagram sources)
├── docker-compose.yml          db + migrate + seed + api + web + sweeper
├── .env.example                Compose variables
└── prd.md                      The full product write-up, milestone by milestone
```

Every folder has its own `AGENTS.md` describing the conventions that apply inside it.

## Prerequisites

- **Node.js ≥ 20** (developed on 22)
- **Docker** with **Compose v2.16+** (the compose file uses `dockerfile_inline`)
- **npm** (workspaces — installs must run from the repository root)
- ~4 GB of free disk for the images

## Environment variables

Copy the examples; never commit real secrets.

```bash
cp .env.example .env                 # compose variables
cp server/.env.example server/.env   # the API's own settings
cp client/.env.local.example client/.env.local
```

**What has to be set**

| Variable             | Where                 | Notes                                                                                                                                                                   |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`       | `.env`              | **Required.** The API refuses to start in production without it. Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATABASE_URL`     | `server/.env`       | `postgres://postgres:postgres@localhost:55432/TeslaB` locally                                                                                                         |
| `COOKIE_SECURE`    | `.env`              | Defaults to`true` under `NODE_ENV=production`. **Must be `false` over plain HTTP** or sign-in silently stops working                                        |
| `API_URL`          | `client/.env.local` | Where the client's server components reach the API                                                                                                                      |
| `API_PROXY_TARGET` | `client/.env.local` | Target of the`/api` rewrite. **Baked in at build time** — changing it requires a rebuild                                                                       |

The interesting tuning knobs — routing timeouts, rush-hour windows, dispatch radii and
freshness, matching thresholds — are all documented inline in `server/.env.example`,
and every one has a working default. The API runs with no `.env` at all.

## Local setup

```bash
git clone <repo> && cd TeslaB
npm install                  # from the root — it is an npm workspace

cp .env.example .env
cp server/.env.example server/.env
cp client/.env.local.example client/.env.local

# set JWT_SECRET in .env (see above)

npm run db:up                # start PostgreSQL + PostGIS + pgRouting
npm run db:migrate           # apply server/db/*.sql
npm run db:seed              # demo accounts, service points, routing graph, pricing
npm run dev                  # API on :4000 and client on :3000
```

Open [http://localhost:3000](http://localhost:3000) and sign in with a [demo account](#demo-credentials).

## Docker

`docker-compose.yml` is self-contained: the two Dockerfile recipes are inlined in it via
`dockerfile_inline`, so there is no `docker/` directory and one file builds all three
images.

```bash
cp .env.example .env         # then set JWT_SECRET
docker compose up -d --build
docker compose ps            # migrate and seed should show Exited (0)
docker compose logs -f api
```

Six services, started in dependency order:

```
db  →  migrate  →  seed  →  api  →  web
                     ↑        ↑
                  sweeper ─────┘
```

| Service     | Role                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- |
| `db`      | PostgreSQL 17 + PostGIS 3.5 + pgRouting. Published on`127.0.0.1:55432` for `psql`. |
| `migrate` | One-shot: applies`server/db/*.sql`. Idempotent, so it is safe on every `up`.       |
| `seed`    | One-shot: demo accounts, service points, the routing graph and the pricing policy.     |
| `api`     | The Express API. No published port — the client proxies to it.                        |
| `web`     | The Next.js client. Published on`:3000`; the only port that needs opening.           |
| `sweeper` | Background loop: expires stale requests, retries waiting ones, expires overdue offers. |

> **The sweeper is not optional.** A ride request that finds no free driver is left
> `WAITING` with nothing scheduled to look again. `retryWaitingRequests` is the safety
> net for the whole dispatch design, and without a scheduler a request that missed its
> window stays missed.

Tear down with `docker compose down` (keeps the data volume) or `down -v` (deletes it).

**Deploying to a small instance:** this file builds `next build` on the machine it runs
on, which wants well over 1 GB. On 1 vCPU / 512 MB it will be OOM-killed. Build the
images elsewhere, push them to a registry, and run `docker compose up -d` on the
instance.

## Migrations and seeding

Migrations are **idempotent and cumulative**. `server/db/NN-*.sql` re-runs on every
`db:migrate`, so each file uses `IF NOT EXISTS` / `DROP … IF EXISTS` and a change to an
already-applied file should be appended as a convergence section instead of edited.

```bash
npm run db:migrate           # apply every file, safe to re-run
npm run db:seed              # demo data; refuses to run in production unless told to
npm run db:reset             # drop the volume and start over
```

The seed builds the routing graph the whole app depends on: **15 zones, 45 service
points, 45 routing vertices and 47 routing edges**. Adding or removing an edge requires
`DELETE FROM routing_edges;` before re-seeding, because `graph_edge_id` is an immutable
byte-order rank and a new edge would collide with an existing id.

## Running the apps and the tests

```bash
npm run dev                  # API + client together
npm run dev:server           # API only   → http://localhost:4000
npm run dev:client           # client only → http://localhost:3000
npm run build                # production build of the client
npm start                    # run both in production mode

npm test                     # the whole server suite (needs the database)
npm run test --workspace server -- --test-name-pattern="fares"
npm run lint                 # client ESLint
```

`npm test` takes a few minutes: the integration suites route real journeys through
pgRouting. **`--test-concurrency=1` is required** and already set — the files share one
database, and two at once corrupt each other's state in ways that look exactly like real
bugs. The suite re-seeds the database, so do not point it at anything you care about.

Useful one-off commands:

```bash
npm run ride-requests:expire      # close requests past their search window
npm run dispatch:sweep            # retry waiting requests, expire overdue offers
npm run pool-fares:recalculate    # rebuild a pool's fare calculations
```

## Demo credentials

All seeded accounts use the password **`DemoPass123!`**.

| Role      | Email                  | Notes                                                               |
| --------- | ---------------------- | ------------------------------------------------------------------- |
| Passenger | `nusrat@example.com` | Seeded with a**500.00 BDT** TeslaPay balance                  |
| Passenger | `rafiq@example.com`  | Seeded with a**500.00 BDT** TeslaPay balance                  |
| Passenger | `shirin@example.com` | Seeded with a**500.00 BDT** TeslaPay balance                  |
| Driver    | `jashim@example.com` | One vehicle,*Bullet*, 3 seats; balance grows from fares collected |

The seeded driver is the only one — a new driver has no vehicle and dispatch cannot use
one — which is why drivers are seeded rather than self-service.

To see the pooling flow, sign in as Nusrat and request **Banani Road 11 → Gulshan 1
Circle**, then as Rafiq and request **Banani Road 11 → Mohakhali Bus Terminal**: they
share one car, and each is billed for the legs they were aboard for rather than the
whole trip.

## Deployment

> **Deployment URL:** _TODO — add the URL here once deployed._

The stack is one `docker compose up` on a single host. Two hosting shapes are worth
knowing about:

**One VM (simplest).** Any host that runs Docker can run the entire compose file —
database included — which is the only way to get the `sweeper` for free.

**Split (managed database + serverless).** Supabase documents both **PostGIS and
pgRouting** as installable extensions, so the database can live there; the API fits on
Render and the client on Vercel. Three things to get right:

1. **`API_PROXY_TARGET` is read at build time** — set it in the build environment, or
   the deployed client will try to proxy to `http://api:4000`.
2. **Set `COOKIE_SECURE=true`** and `CLIENT_ORIGIN` to the client's public URL once
   everything is HTTPS.
3. **The `sweeper` has no home on either free tier** — neither runs a long-lived
   process. Without an external scheduler, waiting ride requests are never retried.
4. Supabase installs extensions into the `extensions` schema, which is a
   `search_path` away from the unqualified `geometry` / `pgr_dijkstra` calls in the
   migrations. Run `npm run db:migrate` against it early to confirm.

Run migrations and the seed against the remote database from your machine:

```bash
DATABASE_URL="postgres://…" npm run db:migrate
DATABASE_URL="postgres://…" npm run db:seed
```

## API overview

Everything is under `/api`. The full contract is `server/openapi.yaml`, browsable at
`GET /api/docs`.

**Passenger**

```text
POST   /auth/register  /auth/login  /auth/logout      GET /auth/me
GET    /location/zones                                GET /location/points
POST   /fare-quotes
POST   /ride-requests                                 (needs an Idempotency-Key header)
GET    /ride-requests/my
GET    /passengers/me/current-ride                    -> { ride } or { ride: null }
GET    /passengers/me/rides[/:id]
POST   /ride-requests/:id/cancel
```

**Driver**

```text
GET    /drivers/me/availability                       -> canGoOnline / canGoOffline
PATCH  /drivers/me/availability                       { online, servicePointCode }
GET    /drivers/me/offers                             also the heartbeat
POST   /drivers/me/offers/:id/accept                  no body
POST   /drivers/me/offers/:id/reject
GET    /drivers/me/current-pool                       allowedActions are the buttons
POST   /drivers/me/pools/:id/depart | /start | /complete
POST   /drivers/me/pools/:id/stops/:stopId/arrive
POST   /drivers/me/pools/:id/stops/:stopId/members/:memberId/pickup | /dropoff
GET    /drivers/me/rides[/:poolId]
```

**TeslaPay**

```text
GET    /payments/me                                   { side, payments, totals }
GET    /payments/me/wallet                            { wallet: { balance, entries } }
POST   /payments/rides/:rideRequestId/pay             { method: TESLA_PAY | CASH }
```

**Conventions across every endpoint**

- No path or body ever names a user. `/me` already knows who is asking.
- A resource that is not the caller's is a **404**, not a 403 — a 403 confirms the id
  exists.
- Lists answer `{ data, pagination }`. Errors answer `{ error: { message } }`.
- Money is an exact decimal **string**, never a JSON number.
- Instants are UTC ISO-8601 or `null`.

## Key decisions and trade-offs

**The server publishes state; the client renders it.** `allowedActions`, `nextAction`,
`canGoOnline`, `canGoOffline`, an offer's `expired` and a payment's `payable` are all
computed from the state on the server, so a client draws the buttons the server would
accept instead of reimplementing the rules. A stale screen shows a control the server
refuses with an explanation — which is better than a screen that guesses wrong.

**State machines live in code, as data.** `ride.status.js`, `dispatch.rules.js`,
`matching.rules.js`, `pool-fare.rules.js` and `trip.rules.js` are pure, unit-tested
modules. The services, the SQL and the tests share one definition of each transition,
and a transition is never re-implemented inline.

**The database enforces the product.** Every guarantee has a `CHECK`, a trigger, a
foreign key or a partial unique index behind it, not only a service check — a wallet
balance that cannot go negative, a payment that can be settled once, a ledger entry that
cannot be rewritten. The trade-off is a schema that is not portable to a database
without triggers, which is fine for a PostGIS-and-pgRouting application.

**Timelines are append-only.** `ride_events` and `pool_events` refuse `UPDATE` by
trigger, and an event is written in the same transaction as the state change it records
— so there is no window in which one exists without the other, and a retry cannot write
a second event.

**Money is exact decimal.** `Prisma.Decimal` (decimal.js-*light*) and `numeric`
columns throughout; a JavaScript `number` is refused for money. Amounts cross the wire
as strings, which costs a `formatMoney` call on the client and buys correctness.

**A read is a projection, not a loop.** A page costs the same however many rows it
returns. Prisma emits `query` events under `NODE_ENV=test`, which is how the read
suites prove it by *counting queries* rather than checking JSON.

**Matching is deliberately narrow (`pool-match.v2`).** Two journeys may share a car only
if they start at the **same service point**, one destination is reachable from the
other, and the driver is at that starting point. This makes some plausible-looking
poolings impossible by design — a Banani Road 11 passenger and a Mohakhali passenger
will never share a car — in exchange for a rule that is explainable in one sentence and
that a passenger can predict. The metric-based limits that used to gate this
(pickup wait, added duration, detour ratio) are still computed and still shown to the
driver as justification, but they no longer refuse anything.

**The client talks to the Next server, which proxies to the API.** `next.config.mjs`
rewrites `/api/:path*` to the API, so the browser is same-origin and the HttpOnly
session cookie works without CORS or a cookie domain. The cost is that the proxy target
is baked in at build time.

**Reading a driver's offers is the heartbeat.** It refreshes `lastSeenAt`, and a
location older than 300 s makes the driver ineligible. So a driver's screen that stops
asking quietly drops out of dispatch — which is why the console polls even in a
background tab.

## Concurrency and data consistency

### The scenario

Bullet has three seats and two passengers aboard, so **one seat is left**. Nusrat and
Shirin both try to claim it within the same few hundred milliseconds, and both are told
that a seat is available.

### Why that is not a race here

Two different things could go wrong, and they are prevented in two different places.

**Only one of them can be offered the seat at all.** Dispatch makes one offer at a
time. `one_pending_offer_per_driver` is a partial unique index on `dispatch_offers`, so
a driver holds at most one pending offer; the candidate query additionally refuses a
pool that already has a pending `ADD_PASSENGER` offer. Shirin is therefore never offered
the seat while Nusrat's offer is open — the second joiner does not get to "claim"
anything, because nothing was offered.

**If both did reach acceptance, the writes serialize.** `acceptOffer` runs inside a
single transaction that takes `SELECT … FOR UPDATE` on the driver profile *and* on the
vehicle before it decides anything. The second transaction blocks on that row lock,
then re-reads the state the first one committed.

**And capacity is recomputed, never remembered.** Inside the transaction the member
count is counted from the rows that exist *now*:

```js
if (members >= pool.capacitySnapshot) throw new ApiError(409, 'That seat is taken');
```

The count the offer was built from is a *proposal*, not a reservation; the check that
decides is made after the lock, against committed state. `capacity_snapshot` is itself a
copy of the vehicle's capacity taken at acceptance, so a later change to the vehicle
cannot retroactively overfill a pool that was planned with the old number.

**The database holds the rest:**

| Guarantee                                    | Enforced by                                       |
| -------------------------------------------- | ------------------------------------------------- |
| A ride request joins at most one pool        | `pool_members.ride_request_id` `UNIQUE`       |
| A driver holds one offer at a time           | `one_pending_offer_per_driver` (partial unique) |
| A request is offered to one driver at a time | `one_pending_initial_offer_per_request`         |
| A driver has one active pool                 | `one_active_pool_per_driver` (partial unique)   |
| Capacity is a positive number                | `ride_pools_capacity_positive` `CHECK`        |
| A lock wait cannot hang forever              | `DISPATCH_TRANSACTION_TIMEOUT_MS` — 15 s       |

A lock that cannot be taken in time therefore surfaces as a `409` carrying a sentence,
not as a hung request. The loser sees an explanation; it does not see a spinner.

### What is deliberately not guaranteed

**Reading a seat count reserves nothing.** A driver reading "1 of 3 seats" is reading a
snapshot that may already be a millisecond stale. That is acceptable — a read does not
allocate — but it does mean a screen can render a state that is no longer true. It is
also why the console re-reads after every action instead of patching the value it acted
on.

**There is no `members ≤ capacity_snapshot` constraint.** Unlike the wallet's
`balance >= 0`, capacity is enforced only by the service check above, under the row
lock. A future code path that inserted a `pool_members` row without going through
`acceptOffer` would not be stopped by the database. This is the one guarantee in the
schema that rests on application code alone, and it is the first thing I would add a
deferred constraint trigger for — this schema's standard everywhere else is that if a
rule matters, a constraint refuses the state it forbids.

### What would change at larger scale

The current design is **pessimistic and single-node**: a `SELECT … FOR UPDATE` on a
driver row is cheap and correct against one Postgres primary, which is the entire
deployment here. It stops being the right tool once there is more than one writer to
coordinate, or once the lock is held long enough to matter.

1. **Optimistic concurrency instead of row locks.** `ride_pools` already carries a
   `version` integer. A compare-and-swap — `UPDATE ride_pools SET version = version + 1 WHERE id = $1 AND version = $2` — lets the second writer *detect* the conflict and
   retry or refuse, rather than blocking. Blocking on a row for the length of a routing
   call is fine with one driver; at a thousand it is a queue, and a lock held across a
   network round trip is a lock held too long.
2. **Reserve the seat at offer time, not at accept time.** Today the seat is taken only
   when the offer is accepted, so two passengers can both be told a seat exists before
   either holds it. A short-lived hold — a row with an `expires_at` — would make the
   offer itself the reservation. The offer's existing 30-second TTL is already the
   natural expiry, and the `sweeper` is already the reaper such a design needs.
3. **Enforce capacity in the database.** A deferred constraint trigger counting members
   against `capacity_snapshot` would make the invariant hold no matter which code path
   writes — bringing the last rule in line with the rest.
4. **Make acceptance idempotent by offer id.** Retrying an accept after a network
   failure should return the same pool, not fail. `dispatch_offers.id` is already a
   natural idempotency key; today `pool_members.ride_request_id UNIQUE` turns a duplicate
   into an error rather than into the original answer.
5. **If writers ever span regions**, a single-primary row lock is no longer available,
   and the choice becomes serializable isolation or partitioning dispatch by city — so
   that every writer contending for one car is in the same place. Partitioning is
   usually the cheaper answer: two passengers competing for one car are, by definition,
   in the same city.

## Scaling to 1M passengers and 100k drivers

This is a reasoning exercise, not a roadmap. The demo is nowhere near these numbers, and
most of what follows is work I would not start until a measurement demanded it. The
useful part is knowing *which* measurement, and in what order.

### The numbers that decide everything

|                                                    |                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Rides                                              | ~2M/day if each passenger rides twice — **~23 rides/s average, ~100/s at peak**           |
| Writes per ride                                    | ~10 (request, offer, accept, six trip commands, complete, settle) — **~1k writes/s peak** |
| **Polling**                                  | 100k online drivers × one offer read every 5 s —**20,000 req/s**                    |
| …and each poll is**three sequential reads** | availability + offers + current-pool —**~60,000 req/s**                              |

That last row is the whole answer. **Matching is not the bottleneck; asking whether
anything changed is.** Against ~100 rides/s of real work, ~60k req/s of clients
confirming that nothing happened is 99.8% of the traffic — and it is not read-only,
because reading a driver's offers refreshes `last_seen_at`. *Reading your offers is also
how the server knows you are still there* was the right design for a demo with one
driver. At 100k it is 20,000 writes/s saying "this driver still exists".

### What breaks, in order

1. **The heartbeat row.** One `UPDATE driver_profiles SET last_seen_at = now()` per
   driver per 5 s, each bumping `updated_at` through a trigger and generating WAL. The
   first change is not structural: a Redis TTL — `SET driver:alive:<id> EX 300` — expresses
   the same fact for nothing.
2. **Polling itself.** Replace both polls with push: offers push on creation, ride
   updates push on each `ride_events` append. The append-only timeline is already the event
   source, so this is a transport change rather than a redesign. A million concurrent
   connections needs a fan-out layer keyed by user id, and is sticky at the edge even
   though the API stays stateless.
3. **Routing CPU.** Every request routes the passenger *and* routes each candidate for
   approach time: ~100 rides/s × up to 20 candidates is thousands of `pgr_dijkstra` calls a
   second, and pgRouting is CPU-bound per query. One of the two fixes is nearly free:
   journeys here are between *named service points*, so a route is a pure function of
   `(graph_version, origin, destination, rush_hour)` — a small, highly reusable key space.
   Precomputing that matrix is the largest CPU saving available.
4. **The liveness signal must survive the transport change.** Delete the poll naively and
   drivers stop being eligible after 300 s.

### The target shape

```mermaid
---
title: TeslaB at scale — what changes, and where
---
flowchart TB
    subgraph clients["Clients"]
        direction LR
        pax(["Passenger apps"])
        drv(["Driver apps"])
    end

    subgraph edge["Edge"]
        direction TB
        waf["WAF + L7 load balancer<br/>health-checked, no sticky sessions<br/>the API is stateless"]
        ws["WebSocket gateway<br/>sticky at the connection layer<br/>replaces the 5 s poll"]
    end

    subgraph api["Stateless API pool"]
        direction TB
        inst["Express instances — scale out freely<br/>a JWT in an HttpOnly cookie means<br/>there is no server session to replicate"]
        limit["Rate limiting<br/>token bucket: auth, writes, offers"]
    end

    subgraph workers["Workers"]
        direction TB
        matcher["Matcher — geo-sharded by city<br/>the only CPU-bound tier: routing<br/>the one plausible extraction"]
        sweeper["Sweeper — leader-elected<br/>expiry, re-offer, retry"]
        fan["Notifications, analytics<br/>fan-out only, never on the critical path"]
    end

    subgraph redis["Redis"]
        direction TB
        alive["Driver liveness TTL<br/>replaces the heartbeat UPDATE"]
        geo["GEO index<br/>driver shortlist by distance"]
        routes["Route cache<br/>graph version, origin, destination, rush hour"]
        keys["Idempotency keys, rate counters"]
    end

    subgraph pg["PostgreSQL"]
        direction TB
        primary["Primary — all writes, and every read<br/>you are about to act on"]
        replicas["Read replicas — history, timelines,<br/>reference data. Never a pending offer."]
        partitions["Partitioned by month:<br/>ride_events, pool_events, wallet_ledger"]
    end

    queue["Delayed queue<br/>offer expiry and the re-offer cascade<br/>instead of a 30 s sweep"]

    pax --> waf
    drv --> ws
    waf --> inst
    ws --> inst
    inst --> limit
    inst --> redis
    inst --> primary
    inst --> queue
    queue --> matcher
    matcher --> geo
    matcher --> routes
    matcher --> primary
    matcher --> ws
    sweeper --> primary
    fan --> ws
    inst -.->|"history, reference"| replicas
    primary --> replicas
    primary --- partitions

    classDef place fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
    classDef app fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    classDef domain fill:#dcfce7,stroke:#16a34a,color:#052e16
    classDef store fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef side fill:#f4f4f5,stroke:#71717a,color:#27272a,stroke-dasharray:4 3

    class pax,drv place
    class waf,ws,inst,limit,matcher,sweeper,fan app
    class queue side
    class alive,geo,routes,keys store
    class primary,replicas,partitions domain
```

The source is `docs/scaling.mmd`. What the diagram is really saying is where each remedy
*lives*: push at the edge, liveness out of Postgres and into Redis, routing as the only
CPU-bound tier, and reads split by consequence — history may lag, the offer you are about
to accept may not.

### Load balancing and horizontal scaling

The API is **already stateless**: the session is a signed JWT in an HttpOnly cookie, so
there is no server-side session to replicate. That is what makes scaling out free, and it
is the property I would protect most carefully. No sticky sessions; an L7 balancer
health-checking `/api/health` is enough. Two things are *not* horizontally scalable as
written — the **sweeper**, where two instances would double-dispatch, and any in-process
scheduling.

### Indexes, replicas and contention

Missing at scale: a **GiST index on `service_points.location`** for the radius query,
**`dispatch_offers (driver_profile_id, status)`** — the hottest query in the system, run
20k×/s — and `ride_requests (passenger_profile_id, requested_at DESC)` for history.

**Replicas: yes for history, timelines and reference data; never for anything you are
about to write against.** Serving the offer you are about to accept from a replica with
200 ms of lag produces double accepts and accepts of expired offers. That is a
correctness bug, not a freshness annoyance.

**Partition by month**: `ride_events`, `pool_events` and especially `wallet_ledger`. The
ledger is the highest-write table and already append-only, so it partitions cleanly.
Contended rows, worst first: `driver_profiles.last_seen_at` (the heartbeat),
`wallet_accounts.balance` — a busy driver's wallet is serialized on every settlement, so at
scale stop updating it inline and materialize it periodically, since the ledger is already
the source of truth — and `ride_pools.version`.

### Caching

Cache the immutable and the derived. **`fare_policies` is already versioned** with
`effective_from` / `effective_to`, which makes it a natural cache key rather than one
needing a TTL. Service points and zones. The **route matrix** above. Never cache
availability, offers, a current pool or ride state — nothing a user is about to act on.
Redis holds the route cache, driver liveness, offer presence, rate counters and
idempotency keys.

### Geospatial search

The existing two-stage design — PostGIS radius shortlist, then route each candidate — is
correct and stays. At scale the shortlist moves to **Redis GEO** while Postgres remains
the durable record. The structural point: **dispatch is local, so the shard key is
geography.** A matcher needs only its own city's drivers and requests; no cross-region
coordination is required, which means this scales by *partitioning* rather than by
distributing.

### Queues and events

Keep the critical path synchronous until p95 matching latency is the binding constraint.
Make asynchronous what is already batch-shaped: offer expiry and the re-offer cascade (a
**delayed queue**, not a 30-second sweep), request expiry, fare recalculation,
notifications, analytics. The append-only event tables are a natural **outbox**. Kafka
belongs on the fan-out side, never in the dispatch path.

### Rate limiting

Nothing exists today. Needed on authentication — bcrypt at cost 10 is a CPU denial-of-service
vector, so concurrent verifications need capping — on writes per user, and on offer
actions per driver. Redis token bucket. The polling endpoints need *replacement* rather
than a limit: throttling them just makes the product worse.

### Idempotency

Mostly already right, and the reasoning is worth stating plainly: **the durable
idempotency mechanism is a database unique constraint, not an HTTP header.** The header
only names the key. Ride requests have one; payments are unique on `ride_request_id` and
a repeat returns the original outcome; trip commands already treat a repeated `arrive` as
a retry. Extend to offer acceptance — the offer id is the natural key — and keep a TTL'd
key table for the rest.

### Observability

Alert on the **matching funnel**, not on 5xx. The dangerous failure here is silent: a
request that never matched and never errored. `POOL_CANDIDATE_EVALUATED` already records
`candidatePools` and `rejections` per request, so the funnel metric is a query away rather
than new instrumentation. Track sweeper lag (oldest waiting request, offers expired
unclaimed), route-cache hit rate, and settlement rate as a business SLO.

### Retry and failure

Already present: `retryWaitingRequests`, offer expiry and re-offer,
`DISPATCH_TRANSACTION_TIMEOUT_MS`, and statement timeouts on routing. Add exponential
backoff with jitter on clients, bounded retries on transient database errors, a **circuit
breaker on the routing layer** — if pgRouting degrades, stop matching into a degraded mode
rather than queueing work behind it — and a dead-letter path for events that fail to
publish. The domain already has the vocabulary for degrading honestly: a request that
cannot be matched becomes `WAITING` with a search window.

### Security

The existing posture is strong and worth preserving deliberately: HttpOnly cookie, no
token in JavaScript, **no user id in any path**, 404-not-403 so ids cannot be confirmed,
whitelist DTOs, and an offer snapshot that deliberately excludes passenger identity. Two
gaps for production: a single `JWT_SECRET` with no `kid`, so **key rotation needs a
dual-key window that does not exist yet**; and `COOKIE_SECURE=false` in the compose file,
which must be `true`. Add secrets from a KMS with rotation, WAF and edge DDoS protection,
and audit logging of money movement — the wallet ledger already *is* that audit log. If a
real payment provider arrives, card data must never touch these servers.

One code-review rule worth writing down: `$queryRawUnsafe` is only safe because every call
site binds parameters. That is a convention a new contributor can break without noticing.

### Deployment

Migrations must become **expand/contract**, because old and new code run simultaneously
during a rollout. The existing convention — idempotent, cumulative, append a convergence
section rather than editing what was applied — is *already* compatible with that, which is
a genuine strength. Move `migrate` and `seed` out of the service lifecycle into a deploy
step. Run the sweeper as a singleton. Add PgBouncer: 100k driver connections is
impossible, and the pooled-connection note in [Deployment](#deployment) applies to
everything at this size.

One property worth naming: the matching rule is **versioned** (`pool-match.v2`). That is
not only documentation — it is a rollout mechanism, so a v3 can be shadow-run against v2
on live traffic before it decides anything.

### What I would not build yet

No microservices — the matcher is the only plausible extraction, and only because routing
is CPU-bound rather than I/O-bound. No Kafka on the critical path. No sharding until a
single primary is genuinely saturated; **vertical scaling, replicas and partitioning come
first and go further than people expect.** No separate real-time service while polling
still fits.

### Staged

| Stage | Scale        | Change                                                                                                                                            |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | today        | Synchronous dispatch, 5 s polling, one primary                                                                                                    |
| 1     | 10k drivers  | Push instead of poll; GiST and hot-path indexes; PgBouncer; ledger partitioned; heartbeat to Redis                                                |
| 2     | 100k drivers | Geo-shard dispatch by city; Redis GEO for location; async matching with a delayed queue; route cache; leader-elected sweeper; extract the matcher |
| 3     | 1M+          | Multi-region, partitioned by city, with no cross-region coordination                                                                              |

**In one line:** this design's scaling story is not "make matching faster". It is "stop
asking 100,000 phones whether anything has changed". Everything after that is ordinary
work.

## Known limitations

- **No payment gateway.** TeslaPay is simulated: a wallet table, a ledger and a
  settlement endpoint. No card, no PSP, no refunds, no payouts.
- **No live GPS.** A driver's position is the service point they went online at, updated
  when they move. There is no continuous tracking.
- **No push notifications.** The client polls; there are no WebSockets, no SSE and no
  mobile push.
- **Polling is the only liveness signal.** A driver whose screen is closed stops being
  offered rides after 300 s.
- **No passenger-side cancellation once a driver has accepted.** The reserved states
  (`CANCELLED`, `NO_SHOW`, `SKIPPED`) are defined and unused, deliberately, until a
  milestone needs them.
- **Ratings, notifications, admin tooling and multi-city support do not exist.**
- **The routing graph is a teaching network, not Dhaka.** 15 zones and 47 edges are
  enough to demonstrate real routing and to include one-way edges; they are not a map.
  Only 1521 of 2025 ordered vertex pairs are reachable, and a few places are near-sinks.
- **`npm test` needs a live database** and re-seeds it, so it cannot run against a
  database you care about.
- **Two assertions in `pool-fare.integration.test.js` fail** (a fare that is expected to
  be uncapped comes back capped, and the event it expects is a reduction). This is a
  modelling question about whether the driver's approach leg belongs in a passenger's
  fare, not a test that needs updating. The full suite has not been re-run since the
  most recent matching change.
- **No observability.** Logs and a health endpoint, no metrics, tracing or alerting.
- **The wallet history is capped** at the 20 most recent movements, so the list does not
  visibly sum to the balance. The balance is the database's own column, reconciled
  against the ledger by a deferred constraint.

## Next improvements

1. **Resolve the two `pool-fare` failures** by deciding whether the approach leg is part
   of a passenger's bill, and encoding the answer in the rule module rather than the
   test.
2. **Wire `retryWaitingRequests` into driver-availability transitions.** Today a
   request that missed its window is only retried by the sweeper; retrying the moment a
   driver becomes free would remove the 30-second gap.
3. **Coordinate the two timeouts.** A request's search window is 600 s but matching
   stops being attempted at 300 s, so between 5 and 10 minutes a passenger is told they
   are still searching while nothing is trying.
4. **A real payment provider** behind the existing `payments` table — the `method` enum
   and the `PENDING → PAID` transition are already the shape a gateway needs.
5. **Driver-initiated cancellation and no-shows**, using the reserved states.
6. **Push instead of polling** for offers and ride updates.
7. **Sharpen the matching rule** beyond "same starting point" once there is a real road
   network to measure on.
8. **Observability**: metrics for dispatch latency, match rate and settlement rate.
9. **Prune the images.** Each image installs the full workspace including
   devDependencies; a production-only install in the API stage would cut roughly a
   gigabyte per image.

## AI usage

Lets be honest about this section. So , when I first saw the PRD, I had spent aleast 2-3 hours for breaking and thinking down the problem into small sub problems with pen and paper. Thats included user perpective, the share pool problem, how the full workflow should be organized. Then I organized the possible API patterns, like how will be the request schema, how will the response come out. After doing these self analysis, I made a end to end LLM prompt having my prepared intuition and feature requirement.I asked for a complete plan. Then I had carefully gone through all of those plan. After getting those steps , I made my implementation flow. Like , map building -> user auth -> ride request and so on. Then I start building each of segments. I started with map building. The initial idea about creating map feature that LLM gave me was a hard coded pre-defined json file with some location seeded inside. But what changed that to gepspatial search that I read earliar. After planning I let AI do the rest of the work including coding and testing.Then I move to other feature part like auth, ride-request service. The commit history tells rest of the story. One important thing I want to say is I DIDNT WRITE ANY SINGLE LINE OF CODE for this project. what I did is reasoning,planning, testing and debugging.

## Demo  video

[drive.google.com/file/d/1GALBd9rBK3cbUBfWJ4Tq8NalDWFtg7Le/view?usp=sharing](https://drive.google.com/file/d/1GALBd9rBK3cbUBfWJ4Tq8NalDWFtg7Le/view?usp=sharing)
