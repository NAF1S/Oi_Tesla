import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import * as assignment from '../../src/services/assignment.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as offers from '../../src/services/offer.service.js';
import { createRideRequest } from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';
import {
  POINTS,
  createTestDriver,
  goOnline,
  loadDemoUser,
  removeTestDriver,
  resetDispatchState,
} from '../helpers/drivers.js';

/**
 * The passenger's read APIs: the ride they are on, their history, one ride.
 *
 * The suite drives real pools through the real product paths -- a quote, a
 * request, a dispatch offer, its acceptance, and the trip commands over HTTP --
 * so nothing here can pass in a state a passenger could not actually be in.
 *
 * Two habits worth naming, both of them about the boundary rather than the happy
 * path. First, every privacy test has **two** passengers who have really ridden:
 * a filter that returned everything would pass a test with one passenger in the
 * database, so the co-passenger is the fixture, not an afterthought. Second, the
 * N+1 test counts the *queries* Prisma issues rather than checking the response
 * shape, because a loop of one query per row would produce exactly the same JSON.
 */

let api;
let nusrat;
let rafiq;
let shirin;
let jashim;
let nusratCookie;
let rafiqCookie;
let shirinCookie;
let jashimCookie;
let extraDriver;

let sequence = 0;
const nextKey = () => `read-api-key-${Date.now()}-${(sequence += 1)}`;

// --- HTTP ---------------------------------------------------------------

const login = async (email) => {
  const response = await api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.demoSeedPassword }),
  });

  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

const post = (cookie, path, body) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (cookie, path) => api.request(path, { headers: cookie ? { cookie } : {} });

// --- Fixtures -----------------------------------------------------------

/** A quote priced now, which is when the plan will be measured. */
const quoteFor = (passenger, { origin = POINTS.PICKUP, destination = POINTS.DESTINATION } = {}) =>
  createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: origin,
    destinationServicePointCode: destination,
    departureAt: new Date(),
  });

const requestRide = async (passenger, options) => {
  const { quote } = await quoteFor(passenger, options);

  const { request } = await createRideRequest({
    passenger,
    fareQuoteId: quote.id,
    idempotencyKey: nextKey(),
  });

  return request;
};

/** A committed pool with one passenger, created the way the product creates one. */
// The driver stands at the pickup: under the v2 matching rule a pool can only
// take another passenger if its driver is already on the shared start point.
const createInitialPool = async ({ driver = jashim, passenger, point = POINTS.PICKUP }) => {
  await goOnline(driver, point);

  const request = await requestRide(passenger);
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });

  return { request, poolId: accepted.pool.id };
};

/** Adds one passenger to a forming pool, the way the product does it. */
const joinPool = async ({ driver = jashim, passenger }) => {
  const request = await requestRide(passenger);

  const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(offered.mode, 'POOL_JOIN', 'the joining passenger must be able to join');

  const accepted = await offers.acceptOffer({ driver, offerId: offered.offerId });

  return { request, poolId: accepted.pool.id };
};

const stopsOf = async (poolId) => {
  const { rows } = await pool.query(
    `SELECT id, pool_member_id, stop_type FROM pool_stops
      WHERE ride_pool_id = $1::uuid ORDER BY sequence`,
    [poolId],
  );
  return rows;
};

/** Drives a pool to completion over HTTP, the way a driver's client would. */
const driveTheWholeTrip = async (poolId, cookie = jashimCookie) => {
  const depart = await post(cookie, `/drivers/me/pools/${poolId}/depart`);
  assert.strictEqual(depart.status, 200, JSON.stringify(depart.body));

  for (const stop of await stopsOf(poolId)) {
    // eslint-disable-next-line no-await-in-loop
    const arrived = await post(cookie, `/drivers/me/pools/${poolId}/stops/${stop.id}/arrive`);
    assert.strictEqual(arrived.status, 200, JSON.stringify(arrived.body));

    if (stop.stop_type === 'PICKUP') {
      // eslint-disable-next-line no-await-in-loop
      const picked = await post(
        cookie,
        `/drivers/me/pools/${poolId}/stops/${stop.id}/members/${stop.pool_member_id}/pickup`,
      );
      assert.strictEqual(picked.status, 200, JSON.stringify(picked.body));

      // The trip may only start once the next actionable stop is not an open
      // pickup. Two passengers at one corner are two consecutive pickups, so the
      // first one is correctly refused -- the second attempt is the one that
      // starts the journey, which is the whole point of the rule.
      // eslint-disable-next-line no-await-in-loop
      const started = await post(cookie, `/drivers/me/pools/${poolId}/start`);
      if (started.status === 409) {
        assert.match(started.body.error.message, /still being collected/);
      } else {
        assert.strictEqual(started.status, 200, JSON.stringify(started.body));
      }
    } else {
      // eslint-disable-next-line no-await-in-loop
      const dropped = await post(
        cookie,
        `/drivers/me/pools/${poolId}/stops/${stop.id}/members/${stop.pool_member_id}/dropoff`,
      );
      assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
    }
  }

  const completed = await post(cookie, `/drivers/me/pools/${poolId}/complete`);
  assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));
  return completed.body.pool;
};

/** One passenger carried through a whole journey, so their history has a row. */
const completedRideFor = async (passenger) => {
  const { request, poolId } = await createInitialPool({ passenger });
  await driveTheWholeTrip(poolId);

  return request;
};

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');
  jashim = await loadDemoUser('jashim@example.com');

  nusratCookie = await login('nusrat@example.com');
  rafiqCookie = await login('rafiq@example.com');
  shirinCookie = await login('shirin@example.com');
  jashimCookie = await login('jashim@example.com');

  extraDriver = await createTestDriver({
    name: 'History Driver',
    email: `history-${Date.now()}@example.com`,
    password: env.demoSeedPassword,
    vehicleName: 'History Car',
  });
});

beforeEach(async () => {
  await resetDispatchState();
});

after(async () => {
  await resetDispatchState();
  await removeTestDriver(extraDriver.email);
  await api?.close();
  await closePool();
});

describe('the current ride', () => {
  it('answers an empty ride rather than a 404 for a passenger who is not riding', async () => {
    const response = await get(nusratCookie, '/passengers/me/current-ride');

    assert.strictEqual(response.status, 200, 'not riding is a normal state, not a missing resource');
    assert.deepStrictEqual(response.body, { ride: null });
  });

  it('reports the matched ride with the pool, the driver and this passenger\'s own stops', async () => {
    const { request, poolId } = await createInitialPool({ passenger: nusrat });

    const response = await get(nusratCookie, '/passengers/me/current-ride');

    assert.strictEqual(response.status, 200);
    const { ride } = response.body;

    assert.strictEqual(ride.rideRequestId, request.id);
    assert.strictEqual(ride.status, 'MATCHED');
    assert.strictEqual(ride.pool.poolId, poolId);
    assert.strictEqual(ride.pool.status, 'FORMING');
    assert.deepStrictEqual(ride.driver, { displayName: 'Jashim' });
    assert.strictEqual(ride.vehicle.name, 'Bullet');
    assert.strictEqual(ride.stage, 'DRIVER_ASSIGNED');
    assert.strictEqual(ride.nextAction, 'WAIT_FOR_DRIVER');
    assert.strictEqual(ride.passengerCount, 1);

    // Their own two stops, in order, with real places.
    assert.deepStrictEqual(ride.myStops.map((stop) => stop.stopType), ['PICKUP', 'DROPOFF']);
    assert.strictEqual(ride.myStops[0].servicePoint.code, POINTS.PICKUP);
    assert.strictEqual(ride.myStops[1].servicePoint.code, POINTS.DESTINATION);

    // The route and the solo estimate the passenger accepted.
    assert.strictEqual(ride.route.distanceMeters, 2214);
    assert.strictEqual(typeof ride.route.durationSeconds, 'number');
    assert.strictEqual(typeof ride.soloEstimate.fare, 'string');
    assert.strictEqual(ride.soloEstimate.currency, 'BDT');
    assert.ok(ride.sharedFare, 'a matched passenger has a pooled fare');
  });

  it('tells the passenger their own journey and nobody else\'s', async () => {
    // A shared pool: two passengers, one car. Each reads their own ride, and
    // neither response may mention the other person by any handle at all.
    const first = await createInitialPool({ passenger: nusrat });
    const second = await joinPool({ passenger: rafiq });

    assert.strictEqual(second.poolId, first.poolId);

    const hers = await get(nusratCookie, '/passengers/me/current-ride');
    const his = await get(rafiqCookie, '/passengers/me/current-ride');

    assert.strictEqual(hers.body.ride.rideRequestId, first.request.id);
    assert.strictEqual(his.body.ride.rideRequestId, second.request.id);

    // The aggregate is shared and honest...
    assert.strictEqual(hers.body.ride.passengerCount, 2);
    assert.strictEqual(his.body.ride.passengerCount, 2);

    // ...and the identity is not there in any form.
    const hersPayload = JSON.stringify(hers.body);
    assert.ok(!hersPayload.includes(second.request.id), 'the co-passenger\'s request id');
    assert.ok(!hersPayload.includes('rafiq@example.com'));
    assert.ok(!hersPayload.includes(rafiq.id));
    assert.ok(!hersPayload.includes(rafiq.passengerProfile.id));
    assert.ok(!hersPayload.includes(rafiq.name), 'the co-passenger\'s full name');

    const hisPayload = JSON.stringify(his.body);
    assert.ok(!hisPayload.includes(first.request.id));
    assert.ok(!hisPayload.includes(nusrat.passengerProfile.id));
    assert.ok(!hisPayload.includes(nusrat.name));

    // Each passenger is shown only their own two stops.
    assert.deepStrictEqual(
      hers.body.ride.myStops.map((stop) => stop.stopId),
      hers.body.ride.myStops.map((stop) => stop.stopId),
    );
    assert.strictEqual(hers.body.ride.myStops.length, 2);
    assert.strictEqual(his.body.ride.myStops.length, 2);
    assert.notDeepStrictEqual(
      hers.body.ride.myStops.map((stop) => stop.stopId),
      his.body.ride.myStops.map((stop) => stop.stopId),
      'two passengers at the same corner are still two different stops',
    );
  });

  it('walks the passenger through the journey and then back to no ride', async () => {
    const { poolId } = await createInitialPool({ passenger: nusrat });

    const stageOf = async () => (await get(nusratCookie, '/passengers/me/current-ride')).body.ride;

    assert.strictEqual((await stageOf()).stage, 'DRIVER_ASSIGNED');

    const [pickupStop] = (await stopsOf(poolId)).filter((stop) => stop.stop_type === 'PICKUP');

    await post(jashimCookie, `/drivers/me/pools/${poolId}/depart`);
    assert.strictEqual((await stageOf()).stage, 'DRIVER_EN_ROUTE');
    assert.strictEqual((await stageOf()).nextAction, 'WATCH_DRIVER');

    await post(jashimCookie, `/drivers/me/pools/${poolId}/stops/${pickupStop.id}/arrive`);
    assert.strictEqual((await stageOf()).stage, 'DRIVER_ARRIVED');
    assert.strictEqual((await stageOf()).nextAction, 'BOARD_VEHICLE');

    await post(
      jashimCookie,
      `/drivers/me/pools/${poolId}/stops/${pickupStop.id}/members/${pickupStop.pool_member_id}/pickup`,
    );
    assert.strictEqual((await stageOf()).stage, 'PICKED_UP');
    assert.strictEqual((await stageOf()).nextAction, 'IN_RIDE');

    await driveTheWholeTrip(poolId);

    const finished = await get(nusratCookie, '/passengers/me/current-ride');
    assert.deepStrictEqual(
      finished.body,
      { ride: null },
      'a finished ride is no longer the current one',
    );
  });

  it('refuses a driver and an anonymous caller', async () => {
    assert.strictEqual((await get(jashimCookie, '/passengers/me/current-ride')).status, 403);
    assert.strictEqual((await get(null, '/passengers/me/current-ride')).status, 401);
  });

  it('rejects a query parameter rather than ignoring it', async () => {
    const response = await get(
      nusratCookie,
      `/passengers/me/current-ride?passengerProfileId=${shirin.passengerProfile.id}`,
    );

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported query parameter/);
  });
});

describe('the ride history', () => {
  it('returns only the caller\'s own rides', async () => {
    // Three passengers, all of whom have really ridden. A filter that returned
    // everything would pass a test with one passenger in the database.
    await completedRideFor(nusrat);
    await completedRideFor(rafiq);
    await completedRideFor(shirin);

    const hers = await get(nusratCookie, '/passengers/me/rides');
    const his = await get(rafiqCookie, '/passengers/me/rides');
    const theirs = await get(shirinCookie, '/passengers/me/rides');

    assert.strictEqual(hers.status, 200);
    assert.strictEqual(hers.body.data.length, 1);
    assert.strictEqual(hers.body.pagination.total, 1);
    assert.strictEqual(his.body.data.length, 1);
    assert.strictEqual(theirs.body.data.length, 1);

    const ids = [hers, his, theirs].map((response) => response.body.data[0].rideRequestId);
    assert.strictEqual(new Set(ids).size, 3, 'each passenger has their own ride and only theirs');
  });

  it('describes a ride without loading its detail', async () => {
    await completedRideFor(nusrat);

    const [ride] = (await get(nusratCookie, '/passengers/me/rides')).body.data;

    assert.deepStrictEqual(Object.keys(ride).sort(), [
      'cancellable',
      'cancelledAt',
      'completedAt',
      'destination',
      'driver',
      'passengerCount',
      'pickup',
      'requestedAt',
      'rideRequestId',
      'route',
      'sharedFare',
      'soloEstimate',
      'startedAt',
      'status',
      'vehicle',
    ]);

    assert.strictEqual(ride.status, 'COMPLETED');
    assert.ok(ride.startedAt, 'this ride began');
    assert.ok(ride.completedAt, 'and ended');
    assert.strictEqual(ride.sharedFare.finalized, true, 'the fare was frozen at departure');
    assert.deepStrictEqual(ride.driver, { displayName: 'Jashim' });
  });

  it('is newest first', async () => {
    const first = await completedRideFor(nusrat);
    const second = await completedRideFor(nusrat);
    const third = await completedRideFor(nusrat);

    const { data } = (await get(nusratCookie, '/passengers/me/rides')).body;

    assert.deepStrictEqual(
      data.map((ride) => ride.rideRequestId),
      [third.id, second.id, first.id],
    );

    const timestamps = data.map((ride) => Date.parse(ride.requestedAt));
    assert.deepStrictEqual(timestamps, [...timestamps].sort((a, b) => b - a));
  });

  it('filters by status', async () => {
    await completedRideFor(nusrat);
    const waiting = await requestRide(nusrat);

    const completed = await get(nusratCookie, '/passengers/me/rides?status=COMPLETED');
    const waitingPage = await get(nusratCookie, '/passengers/me/rides?status=WAITING');

    assert.strictEqual(completed.body.pagination.total, 1);
    assert.strictEqual(completed.body.data[0].status, 'COMPLETED');
    assert.strictEqual(waitingPage.body.pagination.total, 1);
    assert.strictEqual(waitingPage.body.data[0].rideRequestId, waiting.id);
  });

  it('filters by a date range on when the ride was requested', async () => {
    await completedRideFor(nusrat);

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const inside = await get(
      nusratCookie,
      `/passengers/me/rides?from=${yesterday.toISOString()}&to=${tomorrow.toISOString()}`,
    );
    const before = await get(
      nusratCookie,
      `/passengers/me/rides?to=${yesterday.toISOString()}`,
    );
    const since = await get(nusratCookie, `/passengers/me/rides?from=${lastWeek.toISOString()}`);

    assert.strictEqual(inside.body.pagination.total, 1, 'the ride is inside a window around now');
    assert.strictEqual(before.body.pagination.total, 0, 'and not before yesterday');
    assert.strictEqual(since.body.pagination.total, 1, 'from last week it is in range');
  });

  it('rejects a malformed filter rather than answering an empty page', async () => {
    for (const query of ['status=NOPE', 'from=not-a-date', 'to=2026-09-25', 'from=2026-02-30T00:00:00Z']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await get(nusratCookie, `/passengers/me/rides?${query}`);

      assert.strictEqual(response.status, 400, query);
      assert.ok(response.body.error.message, query);
    }

    const unknown = await get(nusratCookie, '/passengers/me/rides?passengerId=1');
    assert.strictEqual(unknown.status, 400);
  });

  it('pages with a total, and stops when the pages are exhausted', async () => {
    await completedRideFor(nusrat);
    await completedRideFor(nusrat);
    await completedRideFor(nusrat);

    const first = await get(nusratCookie, '/passengers/me/rides?limit=2');
    const second = await get(nusratCookie, '/passengers/me/rides?limit=2&offset=2');

    assert.deepStrictEqual(first.body.pagination, {
      limit: 2,
      offset: 0,
      returned: 2,
      total: 3,
      hasMore: true,
    });
    assert.deepStrictEqual(second.body.pagination, {
      limit: 2,
      offset: 2,
      returned: 1,
      total: 3,
      hasMore: false,
    });

    const seen = [...first.body.data, ...second.body.data].map((ride) => ride.rideRequestId);
    assert.strictEqual(new Set(seen).size, 3, 'no ride appears twice and none is skipped');
  });

  it('rejects a page size outside its bounds', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await get(nusratCookie, `/passengers/me/rides?${query}`);
      assert.strictEqual(response.status, 400, query);
    }
  });

  it('is stable when rows share a timestamp, which is what the id tie-breaker is for', async () => {
    // Three completed requests written with the *same* `requested_at`, which is
    // what a busy system produces by accident and what a test can only produce by
    // writing the row. Without the id in the ORDER BY, PostgreSQL is free to
    // return them in any order, and a client paging through them sees one twice
    // and misses another.
    const sharedInstant = new Date('2026-09-20T06:00:00.000Z');
    const ids = [];

    for (let index = 0; index < 3; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { quote } = await quoteFor(nusrat);

      // The request's endpoints are checked against the quote's, so the raw row
      // has to name the same two places the quote priced.
      // eslint-disable-next-line no-await-in-loop
      const { rows: quoted } = await pool.query(
        `SELECT origin_service_point_id, destination_service_point_id
           FROM fare_quotes WHERE id = $1::uuid`,
        [quote.id],
      );

      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `INSERT INTO ride_requests (
           passenger_profile_id, fare_quote_id, pickup_service_point_id, dropoff_service_point_id,
           status, requested_at, search_expires_at, started_at, completed_at,
           idempotency_key, request_fingerprint, accepted_fare, currency,
           accepted_pricing_code, accepted_pricing_version,
           accepted_distance_meters, accepted_duration_seconds)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 'COMPLETED', $5, $6, $5, $5,
                 $7, $8, $9, 'BDT', 'dhaka-solo', 1, 2214, 569)
         RETURNING id`,
        [
          nusrat.passengerProfile.id,
          quote.id,
          quoted[0].origin_service_point_id,
          quoted[0].destination_service_point_id,
          sharedInstant,
          new Date(sharedInstant.getTime() + 600_000),
          nextKey(),
          // A fingerprint is a SHA-256 digest in lower-case hex, and the database
          // enforces exactly that.
          `${"a1b2c3d4e5f6".repeat(5)}${index}`.padEnd(64, '0').slice(0, 64),
          '130.630000',
        ],
      );

      ids.push(rows[0].id);
    }

    const walkThePages = async () => {
      const seen = [];

      for (let offset = 0; offset < 3; offset += 1) {
        // eslint-disable-next-line no-await-in-loop
        const page = await get(nusratCookie, `/passengers/me/rides?limit=1&offset=${offset}`);
        assert.strictEqual(page.body.data.length, 1, `page ${offset}`);
        assert.strictEqual(page.body.pagination.total, 3);
        seen.push(page.body.data[0].rideRequestId);
      }

      return seen;
    };

    const firstWalk = await walkThePages();
    const secondWalk = await walkThePages();

    assert.strictEqual(new Set(firstWalk).size, 3, 'every page is a different row');
    assert.deepStrictEqual(firstWalk, secondWalk, 'and the order does not change between reads');
    assert.deepStrictEqual([...firstWalk].sort(), [...ids].sort(), 'all three are reachable');
  });
});

describe('one ride in detail', () => {
  it('adds the stops, the timeline and the pool to a summary', async () => {
    const request = await completedRideFor(nusrat);

    const response = await get(nusratCookie, `/passengers/me/rides/${request.id}`);

    assert.strictEqual(response.status, 200);
    const ride = response.body;

    assert.strictEqual(ride.rideRequestId, request.id);
    assert.strictEqual(ride.stage, 'RIDE_COMPLETED');
    assert.strictEqual(ride.nextAction, 'RIDE_FINISHED');
    assert.strictEqual(ride.memberStatus, 'DROPPED_OFF');
    assert.deepStrictEqual(ride.myStops.map((stop) => stop.stopType), ['PICKUP', 'DROPOFF']);
    assert.deepStrictEqual(
      ride.myStops.map((stop) => stop.status),
      ['COMPLETED', 'COMPLETED'],
    );
    assert.ok(ride.sharedRoute.distanceMeters > 0);
    assert.strictEqual(ride.pool.status, 'COMPLETED');
    assert.strictEqual(ride.pool.passengerCount, 1);
    assert.strictEqual(ride.pool.capacity, 3);
    assert.strictEqual(ride.member.memberStatus, 'DROPPED_OFF');
    assert.ok(ride.member.pickedUpAt);
    assert.ok(ride.member.droppedOffAt);

    // The timeline reads like a journey, in order, with phases.
    assert.ok(ride.timeline.length >= 5);
    assert.deepStrictEqual(
      [...ride.timeline].map((entry) => entry.sequence),
      [...ride.timeline].map((entry) => entry.sequence).sort((a, b) => a - b),
    );
    assert.ok(ride.timeline.every((entry) => entry.label && entry.phase && entry.eventType));
    assert.strictEqual(ride.timeline[0].eventType, 'RIDE_REQUESTED');
  });

  it('answers 404 for another passenger\'s ride rather than 403', async () => {
    const request = await completedRideFor(nusrat);

    // A 403 would confirm the id is real, which tells one passenger that another
    // passenger's ride exists. The two answers are the same on purpose, down to
    // the message's shape -- only the id the caller supplied differs.
    const hers = await get(rafiqCookie, `/passengers/me/rides/${request.id}`);
    const unknown = await get(
      rafiqCookie,
      '/passengers/me/rides/00000000-0000-4000-8000-000000000000',
    );

    assert.strictEqual(hers.status, 404);
    assert.strictEqual(unknown.status, 404);
    assert.deepStrictEqual(Object.keys(hers.body), Object.keys(unknown.body));
    assert.match(hers.body.error.message, /was not found$/);
    assert.match(unknown.body.error.message, /was not found$/);
  });

  it('protects the nested resource, not only the list', async () => {
    const request = await completedRideFor(nusrat);

    assert.strictEqual((await get(shirinCookie, `/passengers/me/rides/${request.id}`)).status, 404);
    assert.strictEqual((await get(jashimCookie, `/passengers/me/rides/${request.id}`)).status, 403);
    assert.strictEqual((await get(null, `/passengers/me/rides/${request.id}`)).status, 401);

    const malformed = await get(nusratCookie, '/passengers/me/rides/not-a-uuid');
    assert.strictEqual(malformed.status, 400);
  });

  it('returns no raw event payload, and no dispatch event at all', async () => {
    const request = await completedRideFor(nusrat);

    const response = await get(nusratCookie, `/passengers/me/rides/${request.id}`);
    const payload = JSON.stringify(response.body);

    // What the audit table holds and a client must never see.
    for (const forbidden of [
      '"metadata"',
      'actorUserId',
      'requestFingerprint',
      'idempotencyKey',
      'passengerProfileId',
      'acceptedSoloFare',
    ]) {
      assert.ok(!payload.includes(forbidden), `${forbidden} must not reach a passenger`);
    }

    // The dispatch family, which is about other people's decisions.
    const { rows } = await pool.query(
      `SELECT event_type FROM ride_events WHERE ride_request_id = $1::uuid`,
      [request.id],
    );
    const written = rows.map((row) => row.event_type);
    assert.ok(written.includes('DRIVER_OFFERED'), 'the audit log really has a dispatch event');

    for (const dispatchEvent of ['DRIVER_OFFERED', 'DRIVER_REJECTED', 'POOL_CANDIDATE_EVALUATED']) {
      assert.ok(!payload.includes(dispatchEvent), `${dispatchEvent} must not reach a passenger`);
    }

    // And every entry is a mapped sentence with a phase, not a raw row.
    for (const entry of response.body.timeline) {
      assert.deepStrictEqual(Object.keys(entry).sort(), [
        'actorType',
        'at',
        'eventType',
        'label',
        'phase',
        'sequence',
      ]);
    }
  });

  it('does not leak a co-passenger through the detail view either', async () => {
    const first = await createInitialPool({ passenger: nusrat });
    const second = await joinPool({ passenger: rafiq });
    await driveTheWholeTrip(first.poolId);

    const hers = await get(nusratCookie, `/passengers/me/rides/${first.request.id}`);
    const payload = JSON.stringify(hers.body);

    assert.ok(!payload.includes(second.request.id));
    assert.ok(!payload.includes(rafiq.name));
    assert.ok(!payload.includes(rafiq.passengerProfile.id));
    assert.strictEqual(hers.body.pool.passengerCount, 2, 'the aggregate is honest');

    // Only her own two stops: the pool had four.
    assert.strictEqual(hers.body.myStops.length, 2);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS stops FROM pool_stops WHERE ride_pool_id = $1::uuid`,
      [first.poolId],
    );
    assert.strictEqual(rows[0].stops, 4, 'the pool really did have four stops');
  });
});

describe('the reads do not become an N+1', () => {
  /**
   * Counts the queries Prisma issues while `work` runs.
   *
   * The client is constructed with query events enabled under `NODE_ENV=test`
   * (see `src/db/prisma.js`), which is what makes this measurable rather than
   * assumed: a page built by looping over its rows would produce identical JSON
   * and a linearly growing count.
   *
   * The listener is attached once and gated by a flag, because the client exposes
   * `$on` but not `$off` -- so there is nothing to detach, and nothing else in the
   * process can be affected by it: the flag is only true inside this helper.
   */
  let queryCount = 0;
  let counting = false;

  prisma.$on('query', () => {
    if (counting) queryCount += 1;
  });

  const countingQueries = async (work) => {
    queryCount = 0;
    counting = true;

    try {
      await work();
      // The last event lands on a later tick, so let the queue drain first.
      await new Promise((resolve) => setImmediate(resolve));
      return queryCount;
    } finally {
      counting = false;
    }
  };

  it('costs the same for a page of one as for a page of five', async () => {
    await completedRideFor(nusrat);

    const small = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?limit=1');
    });

    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await completedRideFor(nusrat);
    }

    const large = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?limit=5');
    });

    const page = await get(nusratCookie, '/passengers/me/rides?limit=5');
    assert.strictEqual(page.body.data.length, 5, 'the page really is five rows');

    // The property that matters. A per-row query would make this grow by one for
    // every ride on the page; the read is built as a fixed number of statements
    // that happen to return a page.
    //
    // The absolute number is not small, and that is Prisma rather than this
    // projection: it resolves each nested relation with its own statement rather
    // than joining, so the two service points, the member, the pool, its vehicle
    // and its driver are several round trips. The count is bounded by the *shape*
    // of a ride, not by how many rides were asked for -- which is exactly what
    // this assertion pins.
    assert.strictEqual(
      large,
      small,
      `a page of five cost ${large} queries and a page of one cost ${small}; that growth is an N+1`,
    );
    assert.ok(small < 40, `a history page should be tens of statements, not ${small}`);
  });

  it('does not grow when the page size grows tenfold', async () => {
    // The same property as above, one order of magnitude apart, so a reader
    // cannot dismiss the first result as two similar small numbers.
    await completedRideFor(nusrat);
    const one = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?limit=1');
    });

    for (let index = 0; index < 9; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await completedRideFor(nusrat);
    }

    const ten = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?limit=10');
    });

    assert.strictEqual((await get(nusratCookie, '/passengers/me/rides?limit=10')).body.data.length, 10);
    assert.strictEqual(ten, one, `ten rows cost ${ten} queries and one cost ${one}`);
  });

  it('stays bounded whatever the filter matches', async () => {
    await completedRideFor(nusrat);

    const empty = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?status=CANCELLED');
    });
    const one = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/rides?status=COMPLETED');
    });

    // Fewer, never more: an empty page skips the fare read entirely, which is the
    // short-circuit `loadFaresForRequests` starts with. What matters is that a
    // filter cannot make a read longer than the page it returns.
    assert.ok(empty <= one, `an empty page cost ${empty} queries and a full one ${one}`);
    assert.ok(one < 40, `a filtered page should be tens of statements, not ${one}`);
  });

  it('reads the current ride in a bounded number of queries', async () => {
    await createInitialPool({ passenger: nusrat });

    const alone = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/current-ride');
    });

    // A co-passenger makes the pool bigger, and must not make the read longer:
    // the response is built from this passenger's own rows whatever the pool holds.
    await joinPool({ passenger: rafiq });

    const shared = await countingQueries(async () => {
      await get(nusratCookie, '/passengers/me/current-ride');
    });

    assert.strictEqual(
      shared,
      alone,
      `a shared pool cost ${shared} queries and a solo one ${alone}; the read should not follow the pool's size`,
    );
    assert.ok(alone < 40, `a current-ride read should be tens of statements, not ${alone}`);
  });
});

describe('scope', () => {
  it('introduces no way to write through the read APIs', async () => {
    for (const path of [
      '/passengers/me/current-ride',
      '/passengers/me/rides',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        // eslint-disable-next-line no-await-in-loop
        const response = await api.request(path, {
          method,
          headers: { cookie: nusratCookie },
        });

        assert.strictEqual(response.status, 404, `${method} ${path}`);
      }
    }
  });

  it('still exposes every path the API had before', async () => {
    // The read APIs are additive. A missing older route would be a rewrite, not
    // an addition, and this is where that would show up.
    for (const [method, path, cookie, expected] of [
      ['GET', '/drivers/me/availability', jashimCookie, 200],
      ['GET', '/drivers/me/current-pool', jashimCookie, 200],
      ['GET', '/drivers/me/pool', jashimCookie, 200],
      ['GET', '/ride-requests/my', nusratCookie, 200],
      ['GET', '/auth/me', nusratCookie, 200],
      ['GET', '/location/points', null, 200],
      ['GET', '/health', null, 200],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await api.request(path, { method, headers: cookie ? { cookie } : {} });
      assert.strictEqual(response.status, expected, `${method} ${path}`);
    }
  });
});
