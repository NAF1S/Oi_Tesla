import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { env } from '../../src/config/env.js';
import { listRideEvents } from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';

/**
 * End-to-end tests for the passenger ride-request endpoints, driven through the
 * real Express app over HTTP against the real database.
 *
 * The point of the suite is the boundary: what a passenger may do, what they may
 * not do *to somebody else's data*, and what a client cannot influence by asking.
 * So the assertions are mostly about identities and status codes -- 401, 403,
 * 404, 409 -- and about the response never carrying anything that is not the
 * caller's business.
 *
 * Two deliberate choices:
 *
 *   1. **Every test starts from a clean ride-request table.** One active request
 *      per passenger is a database constraint, so a leaked WAITING row from an
 *      earlier test would turn the next one into a 409 for the wrong reason.
 *      `beforeEach` deletes the requests (their events cascade with them).
 *   2. **Quotes are real.** Nothing here fabricates a quote row except the one
 *      test that simulates a pre-milestone quote, and that one does it by
 *      clearing an owner on a real quote.
 */

const ORIGIN = 'banani-road-11';
const DESTINATION = 'mohakhali-bus-terminal';
/** 08:41 in Dhaka -- inside the morning peak, so the fare is deterministic. */
const DEPARTURE = '2026-09-24T08:41:00+06:00';

/** The complete key set of a passenger-facing ride request. */
const RIDE_REQUEST_KEYS = [
  'acceptedQuote',
  'cancellable',
  'cancellationReason',
  'cancelledAt',
  'completedAt',
  'destination',
  'id',
  'pickup',
  'requestedAt',
  'searchExpiresAt',
  'startedAt',
  'status',
  // The passenger's own trip. Null until the caller loads one: this endpoint is
  // the request, and the trip is read for a single request rather than a page.
  'trip',
];

const ACCEPTED_QUOTE_KEYS = [
  'currency',
  'distanceMeters',
  'durationSeconds',
  'fare',
  'fareQuoteId',
  'pricingCode',
  'pricingVersion',
];

/** A syntactically valid UUID that will never exist in the database. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

let api;
let nusrat;
let rafiq;
let jashim;
/** A counter so every test gets a unique idempotency key. */
let keySequence = 0;

const nextKey = (label = 'test') => `${label}-key-${Date.now()}-${(keySequence += 1)}`;

const jsonPost = (body, cookie, extraHeaders = {}) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

const login = async (email) => {
  const response = await api.request(
    '/auth/login',
    jsonPost({ email, password: env.demoSeedPassword }, null),
  );
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

/** Creates a real quote as the given passenger and returns its id. */
const createQuote = async (cookie, overrides = {}) => {
  const response = await api.request(
    '/fare-quotes',
    jsonPost(
      {
        originServicePointCode: ORIGIN,
        destinationServicePointCode: DESTINATION,
        departureAt: DEPARTURE,
        ...overrides,
      },
      cookie,
    ),
  );

  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  return response.body.quoteId;
};

const createRequest = (cookie, { key, quoteId, body, headers }) => {
  const payload = body ?? { fareQuoteId: quoteId };
  return api.request(
    '/ride-requests',
    jsonPost(payload, cookie, { 'Idempotency-Key': key, ...headers }),
  );
};

const createRequestOk = async (cookie, options = {}) => {
  const response = await createRequest(cookie, {
    key: options.key ?? nextKey(),
    ...options,
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  return response.body;
};

/** Quote + request in one call: the arrangement most tests need. */
const requestRide = async (cookie, overrides = {}) => {
  const quoteId = overrides.quoteId ?? (await createQuote(cookie, overrides.quote));
  return createRequestOk(cookie, { quoteId, key: overrides.key ?? nextKey() });
};

const requestRow = async (rideRequestId) => {
  const { rows } = await pool.query(
    `SELECT status, requested_at, search_expires_at, cancelled_at, cancellation_reason,
            idempotency_key, request_fingerprint, accepted_fare::text AS accepted_fare
       FROM ride_requests WHERE id = $1::uuid`,
    [rideRequestId],
  );
  return rows[0];
};

/**
 * Money equality across representations.
 *
 * A `numeric(12,6)` column prints `130.630000` while the response presents the
 * same amount at the quote's own scale (`130.63`). Both are exact; the comparison
 * is by value, never by string, so a trailing zero cannot fail a test and a real
 * one-paisa difference cannot pass it.
 */
const assertSameMoney = (responseAmount, storedAmount, message) =>
  assert.ok(
    new Prisma.Decimal(responseAmount).equals(new Prisma.Decimal(storedAmount)),
    `${message}: response ${responseAmount} vs stored ${storedAmount}`,
  );

/**
 * Runs `fn` with the current pricing policy's quote TTL shortened to one second,
 * then restores it.
 *
 * This is the only supported way to reach an expired quote: quotes are immutable
 * (07-fare-pricing.sql refuses an UPDATE outright), so a test cannot age one. The
 * TTL is operational metadata that the policy is still allowed to change, which
 * is exactly why the production path can be exercised rather than simulated.
 */
const withOneSecondQuoteTtl = async (fn) => {
  const policy = await pool.farePolicy.findFirst({ where: { code: env.fare.pricingCode } });
  assert.ok(policy, 'the suite needs the seeded pricing policy');

  const original = policy.quoteTtlSeconds;
  await pool.farePolicy.update({ where: { id: policy.id }, data: { quoteTtlSeconds: 1 } });
  try {
    return await fn();
  } finally {
    await pool.farePolicy.update({ where: { id: policy.id }, data: { quoteTtlSeconds: original } });
  }
};

/** Waits out a deadline that has already been set to one second. */
const waitPastOneSecondTtl = () => new Promise((resolve) => setTimeout(resolve, 1_100));

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await login('nusrat@example.com');
  rafiq = await login('rafiq@example.com');
  jashim = await login('jashim@example.com');
});

beforeEach(async () => {
  // Requests only. Quotes are per-test anyway, and deleting them would break the
  // audit value of the rows the tests are about.
  await pool.query(`DELETE FROM ride_requests`);
});

after(async () => {
  await api?.close();
  await closePool();
});

describe('authentication and authorization', () => {
  const ENDPOINTS = [
    { method: 'POST', path: '/ride-requests' },
    { method: 'GET', path: '/ride-requests/my' },
    { method: 'GET', path: `/ride-requests/${ABSENT_ID}` },
    { method: 'POST', path: `/ride-requests/${ABSENT_ID}/cancel` },
  ];

  it('rejects every endpoint without a session', async () => {
    for (const { method, path } of ENDPOINTS) {
      const response = await api.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': nextKey('anon') },
        body: method === 'POST' ? JSON.stringify({ fareQuoteId: ABSENT_ID }) : undefined,
      });

      assert.strictEqual(response.status, 401, `${method} ${path}`);
      assert.match(response.body.error.message, /Authentication required/);
    }
  });

  it('rejects a driver with 403 rather than pretending the request is missing', async () => {
    for (const { method, path } of ENDPOINTS) {
      const response = await api.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          cookie: jashim,
          'Idempotency-Key': nextKey('driver'),
        },
        body: method === 'POST' ? JSON.stringify({ fareQuoteId: ABSENT_ID }) : undefined,
      });

      assert.strictEqual(response.status, 403, `${method} ${path}`);
      assert.match(response.body.error.message, /do not have access/i);
    }
  });

  it('authenticates before it validates, so a stranger learns nothing from a bad body', async () => {
    const response = await createRequest(null, { key: 'x', body: { fareQuoteId: 'not-a-uuid' } });

    assert.strictEqual(response.status, 401);
  });

  it('takes the passenger from the session, never from the body', async () => {
    const quoteId = await createQuote(nusrat);

    const response = await createRequest(nusrat, {
      key: nextKey('injected'),
      body: { fareQuoteId: quoteId, passengerProfileId: ABSENT_ID },
    });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /passengerProfileId/);
  });

  it('refuses an identifier in the path that the caller cannot address', async () => {
    // An unauthenticated caller cannot read a request even by guessing its id.
    const response = await api.request(`/ride-requests/${ABSENT_ID}`);

    assert.strictEqual(response.status, 401);
  });
});

describe('creating a ride request', () => {
  it('creates a WAITING request and returns the passenger view of it', async () => {
    const quoteId = await createQuote(nusrat);
    const response = await createRequest(nusrat, { key: nextKey(), quoteId });

    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    assert.deepStrictEqual(Object.keys(response.body).sort(), RIDE_REQUEST_KEYS);
    assert.deepStrictEqual(Object.keys(response.body.acceptedQuote).sort(), ACCEPTED_QUOTE_KEYS);

    assert.strictEqual(response.body.status, 'WAITING');
    assert.strictEqual(response.body.cancellable, true);
    assert.strictEqual(response.body.pickup.code, ORIGIN);
    assert.strictEqual(response.body.destination.code, DESTINATION);
    assert.strictEqual(response.body.cancelledAt, null);
    assert.strictEqual(response.body.cancellationReason, null);
    assert.strictEqual(response.body.startedAt, null);
    assert.strictEqual(response.body.completedAt, null);
    assert.strictEqual(response.body.trip, null, 'a ride that has not been matched has no trip');
    assert.strictEqual(response.body.acceptedQuote.fareQuoteId, quoteId);
    assert.match(response.body.id, /^[0-9a-f-]{36}$/);
  });

  it('opens a search window of the configured length from the request instant', async () => {
    const body = await requestRide(nusrat);
    const row = await requestRow(body.id);

    const requested = new Date(row.requested_at).getTime();
    const expires = new Date(row.search_expires_at).getTime();

    assert.strictEqual(
      (expires - requested) / 1000,
      env.rideRequests.searchTtlSeconds,
      'search_expires_at must be requested_at plus the search TTL',
    );
    assert.strictEqual(body.searchExpiresAt, new Date(expires).toISOString());
    assert.strictEqual(body.requestedAt, new Date(requested).toISOString());
  });

  it('copies the accepted values from the quote rather than recomputing them', async () => {
    const quoteId = await createQuote(nusrat);
    const created = await createRequestOk(nusrat, { quoteId, key: nextKey() });

    // The oracle: the quote row itself, read independently of the service.
    const { rows } = await pool.query(
      `SELECT final_fare::text AS final_fare, currency, pricing_code, pricing_version,
              distance_meters, duration_seconds
         FROM fare_quotes WHERE id = $1::uuid`,
      [quoteId],
    );
    const quote = rows[0];

    assert.strictEqual(created.acceptedQuote.fareQuoteId, quoteId);
    assertSameMoney(created.acceptedQuote.fare, quote.final_fare, 'the accepted fare must match the quote');
    assert.strictEqual(created.acceptedQuote.currency, quote.currency);
    assert.strictEqual(created.acceptedQuote.pricingCode, quote.pricing_code);
    assert.strictEqual(created.acceptedQuote.pricingVersion, quote.pricing_version);
    assert.strictEqual(created.acceptedQuote.distanceMeters, quote.distance_meters);
    assert.strictEqual(created.acceptedQuote.durationSeconds, quote.duration_seconds);
  });

  it('stores the accepted amount on the request, where it cannot drift', async () => {
    const created = await requestRide(nusrat);

    // A stored column, not a join, and the columns that hold it are on the
    // request itself. Combined with the quote's own immutability trigger, there
    // is no path by which a later reprice could change what this passenger agreed.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ride_requests'
          AND column_name ~ '^accepted_' ORDER BY column_name`,
    );

    assert.deepStrictEqual(
      rows.map((row) => row.column_name),
      [
        'accepted_distance_meters',
        'accepted_duration_seconds',
        'accepted_fare',
        'accepted_pricing_code',
        'accepted_pricing_version',
      ],
    );

    const row = await requestRow(created.id);
    assertSameMoney(row.accepted_fare, created.acceptedQuote.fare, 'the stored fare must match the response');
  });

  it('records exactly one RIDE_REQUESTED event, attributed to the passenger', async () => {
    const created = await requestRide(nusrat);
    const events = await listRideEvents(created.id);

    // Creating a request over HTTP also runs the first assignment attempt, so
    // the timeline continues past the creation event; this test is about the
    // creation event itself being written exactly once, first.
    assert.strictEqual(
      events.filter((event) => event.eventType === 'RIDE_REQUESTED').length,
      1,
    );
    assert.strictEqual(events[0].sequence, 1);
    assert.strictEqual(events[0].eventType, 'RIDE_REQUESTED');
    assert.strictEqual(events[0].actorType, 'PASSENGER');
    assert.strictEqual(events[0].previousStatus, null);
    assert.strictEqual(events[0].newStatus, 'WAITING');
    assert.strictEqual(events[0].metadata.fareQuoteId, created.acceptedQuote.fareQuoteId);

    const tail = events.slice(1).map((event) => event.eventType);
    assert.ok(
      tail.every((type) => type === 'INITIAL_DISPATCH_FALLBACK'),
      `nothing but an assignment attempt may follow creation, got: ${tail.join(', ')}`,
    );
  });

  it('refuses a body field the passenger does not control', async () => {
    const quoteId = await createQuote(nusrat);

    for (const field of [
      { status: 'COMPLETED' },
      { fare: '0.01' },
      { currency: 'USD' },
      { distanceMeters: 1 },
      { durationSeconds: 1 },
      { pricingCode: 'free' },
      { pricingVersion: 99 },
      { requestFingerprint: 'f'.repeat(64) },
      { idempotencyKey: 'body-supplied' },
    ]) {
      const response = await createRequest(nusrat, {
        key: nextKey('injected'),
        body: { fareQuoteId: quoteId, ...field },
      });

      assert.strictEqual(response.status, 400, JSON.stringify(Object.keys(field)));
      assert.match(response.body.error.message, /Unsupported body field/);
    }
  });

  it('requires a usable fareQuoteId', async () => {
    for (const [fareQuoteId, expected] of [
      [undefined, /fareQuoteId is required/],
      ['', /fareQuoteId must be a UUID/],
      ['not-a-uuid', /fareQuoteId must be a UUID/],
      [42, /fareQuoteId must be a string/],
      [ABSENT_ID, /was not found/],
    ]) {
      const response = await createRequest(nusrat, {
        key: nextKey('bad-quote'),
        body: fareQuoteId === undefined ? {} : { fareQuoteId },
      });

      const status = fareQuoteId === ABSENT_ID ? 404 : 400;
      assert.strictEqual(response.status, status, String(fareQuoteId));
      assert.match(response.body.error.message, expected);
    }
  });

  it('requires an Idempotency-Key header', async () => {
    const quoteId = await createQuote(nusrat);

    const withoutHeader = await api.request(
      '/ride-requests',
      jsonPost({ fareQuoteId: quoteId }, nusrat),
    );
    assert.strictEqual(withoutHeader.status, 400);
    assert.match(withoutHeader.body.error.message, /Idempotency-Key header is required/);
  });

  it('rejects an Idempotency-Key that is too short, too long, or not a safe token', async () => {
    const quoteId = await createQuote(nusrat);

    const bad = [
      'short',
      'x'.repeat(129),
      'has space in it',
      'has/slash',
      'semi;colon',
      'comma,separated',
      'quote"inside',
      '',
    ];

    for (const key of bad) {
      const response = await createRequest(nusrat, { key, quoteId });

      assert.strictEqual(response.status, 400, `expected 400 for key ${JSON.stringify(key)}`);
      assert.match(response.body.error.message, /Idempotency-Key/);
    }
  });

  it('accepts a key made of the documented safe characters', async () => {
    const quoteId = await createQuote(nusrat);
    const response = await createRequest(nusrat, {
      key: `aZ0-9._:${Date.now()}`,
      quoteId,
    });

    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  });

  it('will not create a request from another passenger?s quote', async () => {
    const quoteId = await createQuote(rafiq);
    const response = await createRequest(nusrat, { key: nextKey('stolen'), quoteId });

    assert.strictEqual(response.status, 404);
    assert.match(response.body.error.message, /was not found/);

    // Nothing was written, and Rafiq's quote is still available to Rafiq.
    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ride_requests`);
    assert.strictEqual(rows[0].count, 0);
  });

  it('will not create a request from an unowned quote left by an earlier phase', async () => {
    const quoteId = await createQuote(nusrat);

    // A quote written before quotes had an owner. Quotes are immutable, so
    // producing one means lifting the trigger for exactly this statement --
    // which is acceptable here and nowhere else.
    await pool.query(`ALTER TABLE fare_quotes DISABLE TRIGGER fare_quotes_immutable`);
    try {
      await pool.query(`UPDATE fare_quotes SET passenger_profile_id = NULL WHERE id = $1::uuid`, [
        quoteId,
      ]);

      const response = await createRequest(nusrat, { key: nextKey('unowned'), quoteId });

      assert.strictEqual(response.status, 404);
      assert.match(response.body.error.message, /was not found/);
    } finally {
      await pool.query(`ALTER TABLE fare_quotes ENABLE TRIGGER fare_quotes_immutable`);
      // DELETE on a quote is allowed by design, and this row is not a real quote.
      await pool.query(`DELETE FROM fare_quotes WHERE id = $1::uuid`, [quoteId]);
    }
  });

  it('refuses an expired quote with a 409 that tells the client what to do', async () => {
    await withOneSecondQuoteTtl(async () => {
      const quoteId = await createQuote(nusrat);
      await waitPastOneSecondTtl();

      const response = await createRequest(nusrat, { key: nextKey('expired'), quoteId });

      assert.strictEqual(response.status, 409);
      assert.match(response.body.error.message, /expired/i);
      assert.match(response.body.error.message, /new quote/i);

      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ride_requests`);
      assert.strictEqual(rows[0].count, 0, 'an expired quote must not leave a request behind');
    });
  });

  it('accepts a quote only once, even under a fresh idempotency key', async () => {
    const quoteId = await createQuote(nusrat);
    const created = await createRequestOk(nusrat, { quoteId, key: nextKey() });

    // The first request still holds the quote, so the second attempt is refused
    // for the quote rather than for the passenger's active slot.
    const response = await createRequest(nusrat, { quoteId, key: nextKey('second') });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /already been used/);
    assert.strictEqual((await requestRow(created.id)).status, 'WAITING');
  });

  it('allows one active request at a time, and says why', async () => {
    await requestRide(nusrat);
    const secondQuote = await createQuote(nusrat);

    const response = await createRequest(nusrat, { key: nextKey('second'), quoteId: secondQuote });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /already has an active ride request/);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM ride_requests WHERE status = 'WAITING'`,
    );
    assert.strictEqual(rows[0].count, 1, 'the refused attempt must not have written a row');
  });

  it('does not let one passenger?s request block another?s', async () => {
    const mine = await requestRide(nusrat);
    const theirs = await requestRide(rafiq);

    assert.notStrictEqual(mine.id, theirs.id);
  });

  it('refuses a request whose endpoint has been taken out of service', async () => {
    const quoteId = await createQuote(nusrat);

    await pool.query(`UPDATE service_points SET active = false WHERE code = $1`, [DESTINATION]);
    try {
      const response = await createRequest(nusrat, { key: nextKey('inactive'), quoteId });

      assert.strictEqual(response.status, 409);
      assert.match(response.body.error.message, /no longer available/);
    } finally {
      await pool.query(`UPDATE service_points SET active = true WHERE code = $1`, [DESTINATION]);
    }
  });

  it('reports a driver-held session as unauthorized even with a valid quote id', async () => {
    const quoteId = await createQuote(nusrat);
    const response = await createRequest(jashim, { key: nextKey('driver'), quoteId });

    assert.strictEqual(response.status, 403);
  });
});

describe('idempotent retries', () => {
  it('returns the original request for the same passenger, key and quote', async () => {
    const quoteId = await createQuote(nusrat);
    const key = nextKey('retry');

    const first = await createRequest(nusrat, { key, quoteId });
    const second = await createRequest(nusrat, { key, quoteId });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 200, 'a retry must not claim to have created anything');
    assert.deepStrictEqual(second.body, first.body, 'the retry must return the same representation');

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ride_requests`);
    assert.strictEqual(rows[0].count, 1, 'a retry must not create a second row');
  });

  it('returns the original request even after it has been cancelled', async () => {
    const quoteId = await createQuote(nusrat);
    const key = nextKey('retry-cancelled');

    const created = (await createRequest(nusrat, { key, quoteId })).body;
    await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ reason: 'CHANGED_MIND' }, nusrat),
    );

    const retry = await createRequest(nusrat, { key, quoteId });

    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.id, created.id);
    assert.strictEqual(retry.body.status, 'CANCELLED');
    assert.strictEqual(retry.body.cancellationReason, 'CHANGED_MIND');
  });

  it('rejects reusing a key for a different request', async () => {
    const key = nextKey('conflict');
    await requestRide(nusrat, { key });

    // A different quote is a different request, so the key cannot mean both.
    const otherQuote = await createQuote(nusrat);
    const response = await createRequest(nusrat, { key, quoteId: otherQuote });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /already used for a different ride request/);
  });

  it('scopes a key to its passenger, so two passengers may use the same one', async () => {
    const key = nextKey('shared-key');

    const mine = await requestRide(nusrat, { key });
    const theirs = await requestRide(rafiq, { key });

    assert.notStrictEqual(mine.id, theirs.id);
  });

  it('treats a key as spent once it has created a request, cancellation or not', async () => {
    const key = nextKey('reuse-after-cancel');
    const first = await requestRide(nusrat, { key });

    await api.request(`/ride-requests/${first.id}/cancel`, jsonPost({}, nusrat));

    // The same key, a different quote: still a conflict -- the key is spent.
    const secondQuote = await createQuote(nusrat);
    const response = await createRequest(nusrat, { key, quoteId: secondQuote });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /already used for a different ride request/);

    // A new key is what starts a new journey.
    const fresh = await createRequest(nusrat, { key: nextKey(), quoteId: secondQuote });
    assert.strictEqual(fresh.status, 201);
  });

  it('stores the fingerprint, and never returns it', async () => {
    const created = await requestRide(nusrat);
    const row = await requestRow(created.id);

    assert.match(row.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(created).includes(row.request_fingerprint));
  });
});

describe('reading a ride request', () => {
  it('returns the caller?s own request', async () => {
    const created = await requestRide(nusrat);
    const response = await api.request(`/ride-requests/${created.id}`, {
      headers: { cookie: nusrat },
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, created);
  });

  it('hides another passenger?s request behind a 404', async () => {
    const created = await requestRide(rafiq);

    for (const cookie of [nusrat, jashim]) {
      const response = await api.request(`/ride-requests/${created.id}`, {
        headers: { cookie },
      });

      // A driver gets 403 from the role guard, a passenger gets 404.
      assert.ok([403, 404].includes(response.status), String(response.status));
      if (response.status === 404) {
        assert.match(response.body.error.message, /was not found/);
      }
    }
  });

  it('answers 404 for an identifier that does not exist and 400 for one that is not an id', async () => {
    const absent = await api.request(`/ride-requests/${ABSENT_ID}`, { headers: { cookie: nusrat } });
    assert.strictEqual(absent.status, 404);

    const malformed = await api.request(`/ride-requests/not-a-uuid`, { headers: { cookie: nusrat } });
    assert.strictEqual(malformed.status, 400);
  });

  it('lists only the caller?s requests', async () => {
    const mine = await requestRide(nusrat);
    const theirs = await requestRide(rafiq);

    const response = await api.request('/ride-requests/my', { headers: { cookie: nusrat } });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.length, 1);
    assert.strictEqual(response.body.data[0].id, mine.id);

    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes(theirs.id));
    assert.ok(!serialized.includes('passengerProfileId'));
  });

  it('keeps a cancelled request in the history', async () => {
    const created = await requestRide(nusrat);
    await api.request(`/ride-requests/${created.id}/cancel`, jsonPost({}, nusrat));

    const response = await api.request('/ride-requests/my', { headers: { cookie: nusrat } });

    assert.strictEqual(response.body.data.length, 1);
    assert.strictEqual(response.body.data[0].status, 'CANCELLED');
  });
});

describe('passenger history', () => {
  /**
   * Builds a small history for one passenger by creating and cancelling
   * requests in turn, since only one may be active at a time. Returns the created
   * requests in creation order.
   */
  const buildHistory = async (count) => {
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const body = await requestRide(nusrat);
      created.push(body);
      await api.request(`/ride-requests/${body.id}/cancel`, jsonPost({}, nusrat));
    }
    return created;
  };

  it('returns newest first with a pagination block', async () => {
    const created = await buildHistory(3);

    const response = await api.request('/ride-requests/my', { headers: { cookie: nusrat } });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(Object.keys(response.body).sort(), ['data', 'pagination']);
    assert.strictEqual(response.body.data.length, 3);
    assert.deepStrictEqual(response.body.pagination, {
      limit: env.rideRequests.historyPageSize,
      offset: 0,
      returned: 3,
      total: 3,
      hasMore: false,
    });

    // Newest first: the last one created is the first one returned.
    assert.strictEqual(response.body.data[0].id, created[created.length - 1].id);
    assert.strictEqual(response.body.data[2].id, created[0].id);
  });

  it('pages with limit and offset without repeating or losing a request', async () => {
    const created = await buildHistory(3);

    const first = await api.request('/ride-requests/my?limit=2', { headers: { cookie: nusrat } });
    assert.strictEqual(first.body.data.length, 2);
    assert.strictEqual(first.body.pagination.total, 3);
    assert.strictEqual(first.body.pagination.hasMore, true);

    const second = await api.request('/ride-requests/my?limit=2&offset=2', {
      headers: { cookie: nusrat },
    });
    assert.strictEqual(second.body.data.length, 1);
    assert.strictEqual(second.body.pagination.hasMore, false);

    const seen = [...first.body.data, ...second.body.data].map((item) => item.id);
    assert.deepStrictEqual(seen.sort(), created.map((item) => item.id).sort());
  });

  it('filters by status', async () => {
    await buildHistory(2);
    await requestRide(nusrat);

    const waiting = await api.request('/ride-requests/my?status=WAITING', {
      headers: { cookie: nusrat },
    });
    assert.strictEqual(waiting.body.data.length, 1);
    assert.strictEqual(waiting.body.data[0].status, 'WAITING');
    assert.strictEqual(waiting.body.pagination.total, 1);

    const cancelled = await api.request('/ride-requests/my?status=CANCELLED', {
      headers: { cookie: nusrat },
    });
    assert.strictEqual(cancelled.body.data.length, 2);
    assert.ok(cancelled.body.data.every((item) => item.status === 'CANCELLED'));

    const expired = await api.request('/ride-requests/my?status=EXPIRED', {
      headers: { cookie: nusrat },
    });
    assert.deepStrictEqual(expired.body.data, []);
  });

  it('understands a status in any case, and refuses one that is not a status', async () => {
    await requestRide(nusrat);

    // Case is not part of the vocabulary: the endpoint normalises it, like every
    // other enum in the API.
    for (const status of ['waiting', 'waiting'.toUpperCase(), ' Waiting ']) {
      const response = await api.request(`/ride-requests/my?status=${encodeURIComponent(status)}`, {
        headers: { cookie: nusrat },
      });

      assert.strictEqual(response.status, 200, status);
      assert.strictEqual(response.body.data.length, 1, status);
    }

    for (const status of ['PENDING', 'MATCHED_BY_DRIVER', 'x']) {
      const response = await api.request(`/ride-requests/my?status=${encodeURIComponent(status)}`, {
        headers: { cookie: nusrat },
      });

      assert.strictEqual(response.status, 400, status);
      assert.match(response.body.error.message, /status must be one of/);
    }
  });

  it('rejects unknown query parameters rather than ignoring them', async () => {
    const response = await api.request('/ride-requests/my?passengerProfileId=x', {
      headers: { cookie: nusrat },
    });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported query parameter/);
  });

  it('keeps the page size inside its documented bounds', async () => {
    for (const [query, expected] of [
      ['?limit=0', 400],
      ['?limit=-1', 400],
      ['?limit=101', 400],
      [`?limit=${env.rideRequests.historyMaxPageSize}`, 200],
      ['?limit=2.5', 400],
      ['?limit=many', 400],
      ['?offset=-1', 400],
      ['?offset=abc', 400],
    ]) {
      const response = await api.request(`/ride-requests/my${query}`, {
        headers: { cookie: nusrat },
      });

      assert.strictEqual(response.status, expected, query);
    }
  });

  it('returns an empty page for a passenger with no history', async () => {
    const cookie = await login('shirin@example.com');
    const response = await api.request('/ride-requests/my', { headers: { cookie } });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.data, []);
    assert.strictEqual(response.body.pagination.total, 0);
    assert.strictEqual(response.body.pagination.hasMore, false);
  });

  it('never lets an unauthenticated caller read a history', async () => {
    const response = await api.request('/ride-requests/my');

    assert.strictEqual(response.status, 401);
  });
});

describe('cancelling a ride request', () => {
  it('cancels a waiting request and records the passenger?s reason', async () => {
    const created = await requestRide(nusrat);

    const response = await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ reason: 'WRONG_LOCATION' }, nusrat),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'CANCELLED');
    assert.strictEqual(response.body.cancellable, false);
    assert.strictEqual(response.body.cancellationReason, 'WRONG_LOCATION');
    assert.ok(response.body.cancelledAt);
    assert.strictEqual(new Date(response.body.cancelledAt).toISOString(), response.body.cancelledAt);
  });

  it('defaults the reason to OTHER when the body says nothing', async () => {
    const created = await requestRide(nusrat);

    for (const body of [{}, undefined]) {
      const fresh = body === undefined ? await requestRide(rafiq) : created;
      const response = await api.request(
        `/ride-requests/${fresh.id}/cancel`,
        jsonPost(body, body === undefined ? rafiq : nusrat),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.cancellationReason, 'OTHER');
    }
  });

  it('appends a RIDE_CANCELLED event behind the creation event', async () => {
    const created = await requestRide(nusrat);
    await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ reason: 'WAIT_TOO_LONG' }, nusrat),
    );

    const events = await listRideEvents(created.id);
    const cancelled = events.at(-1);

    // The assignment attempt for a ride nobody can be matched to is recorded
    // between the two lifecycle events, so this asserts about ordering rather
    // than about a fixed timeline.
    assert.strictEqual(events[0].sequence, 1);
    assert.strictEqual(events[0].eventType, 'RIDE_REQUESTED');
    assert.strictEqual(events[0].actorType, 'PASSENGER');
    assert.strictEqual(cancelled.eventType, 'RIDE_CANCELLED');
    assert.strictEqual(cancelled.actorType, 'PASSENGER');
    assert.ok(cancelled.sequence > events[0].sequence, 'the cancellation comes after creation');
    assert.strictEqual(cancelled.previousStatus, 'WAITING');
    assert.strictEqual(cancelled.newStatus, 'CANCELLED');
    assert.strictEqual(cancelled.metadata.reason, 'WAIT_TOO_LONG');
  });

  it('refuses a second cancellation', async () => {
    const created = await requestRide(nusrat);
    const path = `/ride-requests/${created.id}/cancel`;

    await api.request(path, jsonPost({}, nusrat));
    const again = await api.request(path, jsonPost({}, nusrat));

    assert.strictEqual(again.status, 409);
    assert.match(again.body.error.message, /already been cancelled/);
  });

  it('rejects a reason outside the vocabulary, but accepts any case of a real one', async () => {
    const created = await requestRide(nusrat);

    const response = await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ reason: 'BECAUSE' }, nusrat),
    );

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /reason must be one of/);

    const lowercase = await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ reason: 'wait_too_long' }, nusrat),
    );

    assert.strictEqual(lowercase.status, 200);
    assert.strictEqual(lowercase.body.cancellationReason, 'WAIT_TOO_LONG');
  });

  it('rejects a body field that would change the request itself', async () => {
    const created = await requestRide(nusrat);

    const response = await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({ status: 'COMPLETED' }, nusrat),
    );

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported body field/);
  });

  it('will not cancel another passenger?s request', async () => {
    const created = await requestRide(rafiq);

    const response = await api.request(
      `/ride-requests/${created.id}/cancel`,
      jsonPost({}, nusrat),
    );

    assert.strictEqual(response.status, 404);

    const row = await requestRow(created.id);
    assert.strictEqual(row.status, 'WAITING', 'the request must be untouched');
    assert.strictEqual(row.cancelled_at, null);
  });

  it('frees the active slot, so the passenger can request again', async () => {
    const first = await requestRide(nusrat);
    await api.request(`/ride-requests/${first.id}/cancel`, jsonPost({}, nusrat));

    const second = await requestRide(nusrat);

    assert.notStrictEqual(second.id, first.id);
    assert.strictEqual(second.status, 'WAITING');
    assert.strictEqual(second.cancellable, true);
  });

  it('answers 404 for an unknown request and 400 for a malformed id', async () => {
    const absent = await api.request(
      `/ride-requests/${ABSENT_ID}/cancel`,
      jsonPost({}, nusrat),
    );
    assert.strictEqual(absent.status, 404);

    const malformed = await api.request('/ride-requests/nope/cancel', jsonPost({}, nusrat));
    assert.strictEqual(malformed.status, 400);
  });
});

describe('phase boundary', () => {
  it('exposes no pooling, matching, driver-acceptance or payment endpoint', async () => {
    for (const path of [
      '/pools',
      '/pool-members',
      '/pool-stops',
      '/matches',
      '/matches/none',
      '/assignments',
      '/payments',
      '/wallets',
      '/notifications',
      '/tracks',
      '/ride-requests/none/matches',
      '/ride-requests/none/accept',
    ]) {
      const { status } = await api.request(path, { headers: { cookie: nusrat } });

      assert.strictEqual(status, 404, `${path} must not exist in this phase`);
    }
  });

  it('introduces the ride and dispatch tables and nothing shared or seated', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ~ '(ride|pool|dispatch|payment|wallet|match|seat|driver_assignment)'
        ORDER BY table_name`,
    );

    // The dispatch milestone added the four pool/dispatch tables, the shared-fare
    // milestone added the two pool-fare tables, and the TeslaPay milestone added
    // the three wallet tables; what must still be absent is anything shared,
    // seated or assigned to a driver.
    assert.deepStrictEqual(rows.map((row) => row.table_name), [
      'dispatch_offers',
      'payments',
      'pool_events',
      'pool_fare_calculations',
      'pool_fare_legs',
      'pool_members',
      'pool_stops',
      'ride_events',
      'ride_pools',
      'ride_requests',
      'wallet_accounts',
      'wallet_ledger',
    ]);
  });

  it('has no seat count, requested seats or per-seat fare anywhere on a request', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('ride_requests', 'ride_events')
          AND column_name ~ '(seat|capacity|passenger_count|pool)'`,
    );

    assert.deepStrictEqual(rows, [], 'a request is one passenger and has no seats');
  });

  it('starts no ride request for a quote the passenger made only to look at a price', async () => {
    // Looking up a fare is not a commitment: the quote exists, the request does not.
    const quoteId = await createQuote(nusrat);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM ride_requests WHERE fare_quote_id = $1::uuid`,
      [quoteId],
    );

    assert.strictEqual(rows[0].count, 0);
  });

  it('leaves the fare-quote and routing endpoints working', async () => {
    const quoteId = await createQuote(nusrat);

    const route = await api.request('/routes/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: nusrat },
      body: JSON.stringify({
        originServicePointCode: ORIGIN,
        destinationServicePointCode: DESTINATION,
        departureAt: DEPARTURE,
      }),
    });

    assert.strictEqual(route.status, 200);
    assert.ok(quoteId);
  });
});
