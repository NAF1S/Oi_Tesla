import 'dotenv/config';

import {
  DEFAULT_RUSH_HOUR_WINDOWS,
  parseRushHourWindows,
} from '../utils/time.js';

const toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};
// Mirrors the defaults in docker-compose.yml so the API works with no .env file.
const defaultDatabaseUrl = () => {
  const user = process.env.POSTGRES_USER ?? 'postgres';
  const password = process.env.POSTGRES_PASSWORD ?? 'postgres';
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '55432';
  const database = process.env.POSTGRES_DB ?? 'TeslaB';
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

/**
 * A development-only fallback so the API still runs with no .env file, matching
 * the database URL convention above. Production must supply a real secret;
 * `assertProductionSecrets()` enforces that when the server boots.
 */
const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-do-not-use-in-production';

export const env = {
  nodeEnv,
  isProduction,
  port: toNumber(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000',
  // The single source of the connection string: the Prisma CLI resolves it
  // through this module too (see prisma7.config.ts), so the API and the CLI
  // can never drift apart.
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl(),

  // --- Authentication ---------------------------------------------------
  jwtSecret: process.env.JWT_SECRET ?? (isProduction ? '' : DEV_JWT_SECRET),
  /** Token lifetime, in seconds. Drives both the JWT `exp` and the cookie Max-Age. */
  authTokenTtlSeconds: toNumber(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 2),
  authCookieName: process.env.AUTH_COOKIE_NAME ?? 'teslab_auth',
  /** Secure cookies are the default in production; override for TLS terminators. */
  cookieSecure: toBoolean(process.env.COOKIE_SECURE, isProduction),
  /** 'lax' suits the same-origin proxy setup; use 'none' only for cross-site use. */
  cookieSameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
  bcryptCost: toNumber(process.env.BCRYPT_COST, 10),

  // --- Demo seed (development only) -------------------------------------
  demoSeedPassword: process.env.DEMO_SEED_PASSWORD ?? 'DemoPass123!',
  allowDemoSeed: toBoolean(process.env.ALLOW_DEMO_SEED, false),

  // --- Routing ----------------------------------------------------------
  routing: {
    /**
     * Asia/Dhaka rush-hour windows, e.g. "07:30-10:30,16:30-20:00". Half-open:
     * the start minute is rush hour, the end minute is not. Invalid values throw
     * here, at process start, so a typo cannot silently mis-price every route.
     */
    rushHourWindows: parseRushHourWindows(
      process.env.RUSH_HOUR_WINDOWS || DEFAULT_RUSH_HOUR_WINDOWS,
    ),
    /** PostgreSQL statement_timeout applied to the routing queries. */
    statementTimeoutMs: toNumber(process.env.ROUTING_STATEMENT_TIMEOUT_MS, 5_000),
    /** Prisma's own ceiling for the routing transaction, above the statement timeout. */
    queryTimeoutMs: toNumber(process.env.ROUTING_QUERY_TIMEOUT_MS, 10_000),
  },

  // --- Fare pricing -----------------------------------------------------
  fare: {
    /**
     * The pricing policy code quotes are calculated with, e.g. "dhaka-solo".
     *
     * The code is chosen here, by configuration, and never by a client: a request
     * cannot select a policy and therefore cannot select a price. The version is
     * not configurable at all -- it is whichever version of this code is
     * effective at the journey's departure instant.
     */
    pricingCode: process.env.FARE_PRICING_CODE ?? 'dhaka-solo',

    /**
     * Pool-fare settings. The shared-fare *rule version* is deliberately not
     * here: it is a constant in the code (`SHARED_FARE_RULE_VERSION`) so that
     * changing the arithmetic is a code change that has to be published, not a
     * deployment setting that could silently re-price a stored calculation.
     */
    pool: {
      /**
       * Ceiling for a shared-fare recalculation run on its own, outside an
       * acceptance transaction. It has to cover routing every leg of the plan,
       * which is a handful of short pgRouting queries.
       */
      transactionTimeoutMs: toNumber(process.env.POOL_FARE_TRANSACTION_TIMEOUT_MS, 20_000),
      /** Most pools one sweep will recalculate, so a repair run stays bounded. */
      maxPoolsPerSweep: toNumber(process.env.POOL_FARE_MAX_POOLS_PER_SWEEP, 200),
    },
  },

  // --- Ride requests ----------------------------------------------------
  rideRequests: {
    /**
     * How long a WAITING request looks for a ride before it expires. Drives
     * `search_expires_at = requested_at + this`, and is the deadline the
     * expiration sweep acts on.
     */
    searchTtlSeconds: toNumber(process.env.RIDE_REQUEST_SEARCH_TTL_SECONDS, 600),
    /** Ceiling for the interactive transaction a lifecycle write runs in. */
    transactionTimeoutMs: toNumber(process.env.RIDE_REQUEST_TRANSACTION_TIMEOUT_MS, 10_000),
    /** Default page size for the passenger's own request history. */
    historyPageSize: toNumber(process.env.RIDE_REQUEST_PAGE_SIZE, 20),
    /** Largest page a client may ask for, so a history read cannot be unbounded. */
    historyMaxPageSize: toNumber(process.env.RIDE_REQUEST_MAX_PAGE_SIZE, 100),
  },

  // --- Dispatch and pools -----------------------------------------------
  dispatch: {
    /**
     * How long a driver has to answer an offer. Deliberately short: an offer
     * holds the passenger's request and the driver's single pending slot, so a
     * long one strands both. 30 seconds keeps the demo flow snappy and the tests
     * deterministic (they inject a clock rather than waiting).
     */
    offerTtlSeconds: toNumber(process.env.DISPATCH_OFFER_TTL_SECONDS, 30),
    /**
     * Stage 1 of the driver search: the PostGIS radius that decides who is worth
     * routing. `maxRadiusMeters` is the ceiling a widened search may use.
     */
    shortlistRadiusMeters: toNumber(process.env.DISPATCH_SHORTLIST_RADIUS_METERS, 3000),
    maxRadiusMeters: toNumber(process.env.DISPATCH_MAX_RADIUS_METERS, 8000),
    /**
     * Stage 2: a candidate whose routed approach is slower than this is not
     * offered the ride, however close they looked on a map.
     */
    maxApproachDurationSeconds: toNumber(process.env.DISPATCH_MAX_APPROACH_SECONDS, 900),
    /**
     * How old `last_seen_at` may be before a driver stops being eligible. A
     * driver who has not reported in is not somewhere we can promise.
     */
    locationFreshnessSeconds: toNumber(process.env.DISPATCH_LOCATION_FRESHNESS_SECONDS, 300),
    /** Ceiling for the offer and acceptance transactions. */
    transactionTimeoutMs: toNumber(process.env.DISPATCH_TRANSACTION_TIMEOUT_MS, 15_000),
    /** Most candidates to route in one dispatch, so a search stays bounded. */
    maxCandidates: toNumber(process.env.DISPATCH_MAX_CANDIDATES, 20),
    /** Default page size for a driver's own offer list. */
    listPageSize: toNumber(process.env.DISPATCH_OFFER_PAGE_SIZE, 20),
    /** Windows the fairness terms are counted over. */
    rejectionWindowSeconds: toNumber(process.env.DISPATCH_REJECTION_WINDOW_SECONDS, 900),
    workloadWindowSeconds: toNumber(process.env.DISPATCH_WORKLOAD_WINDOW_SECONDS, 3600),
    /**
     * Scoring weights, all in seconds (see dispatch.rules.js). They are
     * configuration rather than constants so dispatch can be tuned without
     * touching the ranking logic -- and a test can set them to zero to isolate
     * proximity.
     */
    scoring: {
      rejectionPenaltySeconds: toNumber(process.env.DISPATCH_REJECTION_PENALTY_SECONDS, 60),
      workloadPenaltySeconds: toNumber(process.env.DISPATCH_WORKLOAD_PENALTY_SECONDS, 30),
      idleCreditPerMinuteSeconds: toNumber(process.env.DISPATCH_IDLE_CREDIT_PER_MINUTE_SECONDS, 5),
      idleCreditMaxSeconds: toNumber(process.env.DISPATCH_IDLE_CREDIT_MAX_SECONDS, 180),
    },
  },

  // --- Pool matching (shared rides) --------------------------------------
  matching: {
    /**
     * A request is only considered for an *existing* pool while it is inside
     * this window. Once the passenger has been waiting longer than this, the
     * dispatcher stops trying to fold them into somebody else's ride and looks
     * for a driver to themselves -- a passenger who has already waited is not
     * helped by a detour.
     */
    windowSeconds: toNumber(process.env.MATCHING_WINDOW_SECONDS, 300),
    /**
     * Stage 1 of pool matching: how near a new pickup has to be to a pool's
     * planned route to be worth simulating. Straight-line metres, used only to
     * shortlist -- the insertion simulation decides.
     *
     * It is a *filter for cost*, not a safety rule, so it is set to the spacing
     * of the seeded zones rather than to a tight corridor: a passenger one zone
     * off a pool's route is exactly who pooling is for, and at 1500 m the
     * Banani Road 11 <-> Mohakhali pair was excluded before any detour rule got
     * to judge it. Everything that actually protects a passenger -- the wait,
     * the added duration and the two detour limits -- is applied afterwards, to
     * the plans this shortlist admits.
     */
    radiusMeters: toNumber(process.env.MATCHING_RADIUS_METERS, 2500),
    /** How near the new destination has to be to the pool's route. */
    destinationRadiusMeters: toNumber(process.env.MATCHING_DESTINATION_RADIUS_METERS, 3000),
    /**
     * The rules a proposed insertion has to satisfy.
     *
     * `maxPickupWaitSeconds` is measured from the passenger's own `requestedAt`,
     * so it includes the matching delay and the driver's approach: it is the time
     * the passenger actually spends waiting.
     */
    maxPickupWaitSeconds: toNumber(process.env.MATCHING_MAX_PICKUP_WAIT_SECONDS, 480),
    maxAddedPoolDurationSeconds: toNumber(process.env.MATCHING_MAX_ADDED_DURATION_SECONDS, 600),
    maxExistingPassengerDetourSeconds: toNumber(
      process.env.MATCHING_MAX_DETOUR_SECONDS,
      600,
    ),    /**
     * The multiple of their own accepted journey a passenger may be asked to
     * travel instead -- "never more than 75% longer than you agreed to".
     *
     * DEMO TUNING, and the loosest of these limits on purpose. It is what decides
     * whether two passengers leaving the same corner for two places a couple of
     * kilometres away share a car: serving both means one of them rides past their
     * own destination and comes back, so the honest number for that kind of pair
     * is around 1.6, not 1.25. Set it to 1.25 for a stricter, more obviously
     * conservative product; the fare caps still guarantee nobody pays more, which
     * is the part that protects a passenger's wallet rather than their time.
     */    maxExistingPassengerDetourRatio: toNumber(process.env.MATCHING_MAX_DETOUR_RATIO, 1.75),
    /**
     * How much a second of pick-up wait and a second of somebody else's detour
     * are worth against a second of extra driving. All ones by default, which
     * makes the score read as "seconds of harm".
     */
    pickupWaitWeight: toNumber(process.env.MATCHING_PICKUP_WAIT_WEIGHT, 1),
    detourWeight: toNumber(process.env.MATCHING_DETOUR_WEIGHT, 1),
    /** Most candidate pools to simulate for one request, nearest first. */
    maxCandidatePools: toNumber(process.env.MATCHING_MAX_CANDIDATE_POOLS, 10),
    /** Ceiling for a pool-join acceptance transaction. */
    transactionTimeoutMs: toNumber(process.env.MATCHING_TRANSACTION_TIMEOUT_MS, 15_000),
  },

  // --- The driver's trip -------------------------------------------------
  trip: {
    /**
     * Ceiling for a trip command (depart, arrive, pickup, start, drop-off,
     * complete). Every one of them is a handful of row writes under locks the
     * command itself takes, so this only has to cover a slow database -- unlike
     * an acceptance, nothing here routes or prices anything.
     */
    transactionTimeoutMs: toNumber(process.env.TRIP_TRANSACTION_TIMEOUT_MS, 10_000),
  },
};

/**
 * Fails fast when a production deployment is missing required secrets.
 *
 * Called from the server bootstrap rather than at module load, so that tooling
 * which merely imports this module (the Prisma CLI, for example) keeps working
 * in a production build image where the secret is supplied only at runtime.
 */
export const assertProductionSecrets = () => {
  if (isProduction && env.jwtSecret === '') {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
};
