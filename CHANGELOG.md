# Changelog

All notable changes to TeslaB are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is `0`, anything may change between minor versions.

<!--
Release process:
  1. move the entries under `## [Unreleased]` into a new version heading below it
  2. npm version <x.y.z[-pre] --no-git-tag-version --workspaces --include-workspace-root
  3. git commit -am "release: vX.Y.Z"
  4. git tag -a vX.Y.Z -m "vX.Y.Z"   &&   git push --follow-tags
  5. GitHub -> Releases -> Draft a new release -> choose the tag ->
     tick "Set as a pre-release" for anything that is not a finished release
-->

## [Unreleased]

Nothing yet.

## [0.1.0-beta.1] — 2026-09-29

The first pre-release. **Both halves of the loop work end to end**: a passenger can
request a ride, a driver can be offered and drive it, two passengers can share the car,
each is billed their own share, and the fare can be settled from a wallet or in cash.

This is a demo, not a product. See *Known issues* below before reading anything into it.

### Added

**Passenger**
- Email/password sign-up and sign-in, with a signed JWT in an HttpOnly cookie. No token
  is ever reachable from JavaScript.
- Service points grouped into zones, and fare quotes between two of them, priced from a
  versioned policy that the server chooses and a client cannot.
- Ride requests from a quote, idempotent by an `Idempotency-Key` header.
- Live tracking of the current ride: driver, car, both stops, the fare and a timeline.
- Cancellation with a reason, while the server still allows it.
- Ride history and per-ride detail as a single projection per page, proved by counting
  queries rather than by checking JSON.

**Driver**
- Going online at a service point and offline again, with `canGoOnline` / `canGoOffline`
  computed by the server.
- Offers **one at a time**, carrying the plan, the metrics that justify it and an expiry.
- Accept (no request body — the stored plan is the plan accepted) and decline.
- The six trip commands: set off, arrive, pick up, start, drop off, complete.
- Current pool with its stops and passengers; the pools driven before.
- Earnings, outstanding fares and a TeslaPay balance.

**TeslaPay (simulated payment)**
- `wallet_accounts`, `payments` and an append-only `wallet_ledger`.
- A completed trip creates one `PENDING` payment per passenger, priced from the frozen
  fare calculation.
- Settlement from the balance (`TESLA_PAY`) or in cash (`CASH`). Paying from the balance
  debits the payer and credits the driver in one transaction, with two ledger entries
  that must agree with both balances.
- Idempotent settlement: a repeat returns the first outcome and moves no money.
- A shortfall is a `409` carrying the amount missing, not a generic failure.

**Matching and pricing**
- `pool-match.v2`. Two journeys share a car only if they start at the **same service
  point**, one destination is reachable from the other, and the driver is at that
  starting point.
- Shared fares: per-leg cost, split by who was aboard for each leg, capped so pooling
  never costs a passenger more than the solo quote they accepted.
- Rush-hour routing costs over a seeded Dhaka road graph (15 zones, 45 service points,
  47 edges, including four one-way) using pgRouting.

**Platform**
- `docker-compose.yml` runs the whole stack — database, migrations, seeding, API, client
  and the background sweeper — from one file, with both Dockerfile recipes inlined.
- `openapi.yaml` as the machine-readable contract, served at `GET /api/docs`, with a test
  that fails if a route is not documented.
- An append-only `ride_events` / `pool_events` timeline per ride and per pool.

### Changed

- **Matching is narrower than it was.** The previous rule used proximity plus four
  metric limits (pickup wait, added duration, detour distance and detour ratio) to decide
  whether two journeys could share a car. Those limits no longer refuse anything — they
  are still measured and still shown to the driver as justification, but eligibility is
  now the three conditions above. Two passengers starting from different places can no
  longer pool, which reverses an earlier behaviour.
- Fare rounding: pooled fares are rounded to the currency's unit, with the rounding
  recorded per passenger rather than absorbed silently.
- `wallet_ledger.payment_id` is `ON DELETE SET NULL` instead of `ON DELETE CASCADE`. A
  ledger entry records money that moved and must outlive the payment that produced it;
  the cascade let a deleted ride destroy the evidence for a balance while leaving the
  balance changed.

### Fixed

- `server/db/14-fare-rounding.sql` re-applied a pre-rounding constraint on every
  migrate, rejecting any pooled fare carrying a non-zero rounding adjustment.
- The wallet ledger read used an inner join onto `payments`, which hid every entry with
  no payment: all `TOP_UP`s, and every settlement whose payment had since been deleted.
  A wallet reported a balance of 10,500.00 against a single visible entry. Both joins are
  now `LEFT`.
- Pool-join offers were unreachable for any driver actually on a ride. The rule "the
  driver must be at the starting point" was checked against the driver's *last reported*
  service point — for a driver mid-ride, the place their previous trip ended — instead of
  where their current plan starts.
- `RIDE_PAID` was missing from the Prisma mirror of `ride_event_type`, so every
  settlement rolled back at the point of writing its event.
- `payable` on a payment DTO ignored who was asking, so a driver was told they could pay
  a fare they were owed.

### Known issues

- **Two assertions fail in `pool-fare.integration.test.js`** — a fare expected to be
  uncapped comes back capped, and the event expected is a reduction. This is a modelling
  question (whether the driver's approach leg belongs in a passenger's fare), not a test
  that needs updating. The full suite has not been re-run since the matching change.
- **There is no `members <= capacity_snapshot` constraint.** Capacity is the one rule in
  the schema enforced only by service code under a row lock. See the README's
  *Concurrency and data consistency* section.
- **A request's search window is 600 s but matching stops at 300 s**, so between five and
  ten minutes a passenger is told they are still searching while nothing is trying.
- **The sweeper is required** and has no host on a free serverless tier. Without it, a
  request that missed its window is never retried.
- No payment gateway, no live GPS, no push notifications, and no passenger-side
  cancellation once a driver has accepted.
- The routing graph is a teaching network, not a map of Dhaka: only 1521 of 2025 ordered
  vertex pairs are reachable.

[Unreleased]: https://github.com/NAF1S/BTesla/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/NAF1S/BTesla/releases/tag/v0.1.0-beta.1
