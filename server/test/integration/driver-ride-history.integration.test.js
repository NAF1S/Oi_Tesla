import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
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
  goOfflineQuietly,
  goOnline,
  loadDemoUser,
  removeTestDriver,
  resetDispatchState,
} from '../helpers/drivers.js';

/**
 * The driver's read APIs: the pool they are on, and the pools they have driven.
 *
 * Where the passenger suite leans on privacy between passengers, this one leans
 * on privacy between *drivers*: two drivers, each with their own pool, and the
 * assertion that neither can name the other's. A history that returned every pool
 * would pass a test with one driver in the database, so two of them are the
 * fixture.
 *
 * The unit is deliberately a pool rather than a ride request, and one test below
 * drives a two-passenger pool to prove the two are not the same thing: one trip,
 * two passengers, one row.
 */

let api;
let jashim;
let nusrat;
let rafiq;
let shirin;
let jashimCookie;
let nusratCookie;
let other;
let otherCookie;

let sequence = 0;
const nextKey = () => `driver-history-key-${Date.now()}-${(sequence += 1)}`;

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

const requestRide = async (passenger, { origin = POINTS.PICKUP, destination = POINTS.DESTINATION } = {}) => {
  const { quote } = await createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: origin,
    destinationServicePointCode: destination,
    departureAt: new Date(),
  });

  const { request } = await createRideRequest({
    passenger,
    fareQuoteId: quote.id,
    idempotencyKey: nextKey(),
  });

  return request;
};

const stopsOf = async (poolId) => {
  const { rows } = await pool.query(
    `SELECT id, pool_member_id, stop_type FROM pool_stops
      WHERE ride_pool_id = $1::uuid ORDER BY sequence`,
    [poolId],
  );
  return rows;
};

/** A pool with one passenger, created the way the product creates one. */
// The driver stands at the pickup: under the v2 matching rule a pool can only
// take another passenger if its driver is already on the shared start point.
const createPool = async ({ driver, passenger, point = POINTS.PICKUP }) => {
  await goOnline(driver, point);

  const request = await requestRide(passenger);
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });
  return { request, poolId: accepted.pool.id };
};

const joinPool = async ({ driver, passenger }) => {
  const request = await requestRide(passenger);

  const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(offered.mode, 'POOL_JOIN');

  const accepted = await offers.acceptOffer({ driver, offerId: offered.offerId });
  return { request, poolId: accepted.pool.id };
};

/** Drives a pool to completion over HTTP. Tolerates the shared-corner start rule. */
const driveTheWholeTrip = async (poolId, cookie) => {
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

/** One completed trip for a driver, and the pool id it produced. */
const completedTrip = async ({ driver, passenger, cookie }) => {
  const { request, poolId } = await createPool({ driver, passenger });
  await driveTheWholeTrip(poolId, cookie);
  return { request, poolId };
};

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  jashim = await loadDemoUser('jashim@example.com');
  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');

  jashimCookie = await login('jashim@example.com');
  nusratCookie = await login('nusrat@example.com');

  other = await createTestDriver({
    name: 'History Other',
    email: `history-other-${Date.now()}@example.com`,
    password: env.demoSeedPassword,
    vehicleName: 'History Car',
  });
  otherCookie = await login(other.email);
});

beforeEach(async () => {
  await resetDispatchState();
});

after(async () => {
  // The test driver's pools go with them; `removeTestDriver` deletes those first,
  // because `ride_pools.driver_profile_id` is RESTRICT.
  await removeTestDriver(other.email);
  await resetDispatchState();
  await api?.close();
  await closePool();
});

describe('the driver\'s history', () => {
  it('is empty for a driver who has not driven', async () => {
    const response = await get(jashimCookie, '/drivers/me/rides');

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.data, []);
    assert.deepStrictEqual(response.body.pagination, {
      limit: 20,
      offset: 0,
      returned: 0,
      total: 0,
      hasMore: false,
    });
  });

  it('returns only the pools assigned to the caller', async () => {
    // Two drivers, each with a completed trip. The third pool belongs to Jashim
    // and is still running, so the test also proves a live pool is in the history
    // rather than only finished ones.
    const mine = await completedTrip({ driver: jashim, passenger: nusrat, cookie: jashimCookie });
    const theirs = await completedTrip({ driver: other, passenger: rafiq, cookie: otherCookie });
    const running = await createPool({ driver: jashim, passenger: shirin });

    const ours = await get(jashimCookie, '/drivers/me/rides');
    const otherHistory = await get(otherCookie, '/drivers/me/rides');

    assert.deepStrictEqual(
      ours.body.data.map((ride) => ride.poolId).sort(),
      [mine.poolId, running.poolId].sort(),
    );
    assert.deepStrictEqual(
      otherHistory.body.data.map((ride) => ride.poolId),
      [theirs.poolId],
      'the other driver sees their own trip and only it',
    );

    const payload = JSON.stringify(ours.body);
    assert.ok(!payload.includes(theirs.poolId), 'the other driver\'s pool id');
    assert.ok(!payload.includes(rafiq.name), 'the other driver\'s passenger');
    assert.ok(!payload.includes(rafiq.passengerProfile.id));
  });

  it('counts one trip per pool, however many passengers it carried', async () => {
    // The unit is a pool, not a ride request. Two passengers in one car is one
    // trip, and a history per request would show it twice.
    const first = await createPool({ driver: jashim, passenger: nusrat });
    const second = await joinPool({ driver: jashim, passenger: rafiq });
    assert.strictEqual(second.poolId, first.poolId);
    await driveTheWholeTrip(first.poolId, jashimCookie);

    const { data, pagination } = (await get(jashimCookie, '/drivers/me/rides')).body;

    assert.strictEqual(pagination.total, 1, 'one car, one journey, one row');
    assert.strictEqual(data[0].passengerCount, 2);
    assert.strictEqual(data[0].stopCount, 4, 'two pickups and two drop-offs');
    assert.strictEqual(data[0].completedStopCount, 4);
  });

  it('is newest first', async () => {
    const first = await completedTrip({ driver: jashim, passenger: nusrat, cookie: jashimCookie });
    const second = await completedTrip({ driver: jashim, passenger: rafiq, cookie: jashimCookie });
    const third = await completedTrip({ driver: jashim, passenger: shirin, cookie: jashimCookie });

    const { data } = (await get(jashimCookie, '/drivers/me/rides')).body;

    assert.deepStrictEqual(
      data.map((ride) => ride.poolId),
      [third.poolId, second.poolId, first.poolId],
    );

    const created = data.map((ride) => Date.parse(ride.createdAt));
    assert.deepStrictEqual(created, [...created].sort((a, b) => b - a));
  });

  it('filters by status and by a date range', async () => {
    const completed = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });
    const running = await createPool({ driver: jashim, passenger: rafiq });

    const done = await get(jashimCookie, '/drivers/me/rides?status=COMPLETED');
    const forming = await get(jashimCookie, '/drivers/me/rides?status=FORMING');

    assert.deepStrictEqual(done.body.data.map((ride) => ride.poolId), [completed.poolId]);
    assert.deepStrictEqual(forming.body.data.map((ride) => ride.poolId), [running.poolId]);

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const inside = await get(
      jashimCookie,
      `/drivers/me/rides?from=${yesterday.toISOString()}&to=${tomorrow.toISOString()}`,
    );
    const before = await get(jashimCookie, `/drivers/me/rides?to=${yesterday.toISOString()}`);

    assert.strictEqual(inside.body.pagination.total, 2, 'both were accepted within a day of now');
    assert.strictEqual(before.body.pagination.total, 0);

    for (const query of ['status=NOPE', 'from=not-a-date', 'limit=0', 'limit=101', 'offset=-1']) {
      // eslint-disable-next-line no-await-in-loop
      assert.strictEqual((await get(jashimCookie, `/drivers/me/rides?${query}`)).status, 400, query);
    }

    assert.strictEqual((await get(jashimCookie, '/drivers/me/rides?driverProfileId=x')).status, 400);
  });

  it('summarises a trip without reading its passengers', async () => {
    const { poolId } = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });

    const [ride] = (await get(jashimCookie, '/drivers/me/rides')).body.data;

    assert.strictEqual(ride.poolId, poolId);
    assert.strictEqual(ride.status, 'COMPLETED');
    assert.deepStrictEqual(Object.keys(ride).sort(), [
      'acceptedAt',
      'completedAt',
      'completedStopCount',
      'createdAt',
      'fare',
      'finalServicePoint',
      'firstServicePoint',
      'passengerCount',
      'poolId',
      'route',
      'status',
      'stopCount',
      'vehicle',
    ]);

    assert.strictEqual(ride.vehicle.name, 'Bullet');
    assert.strictEqual(ride.firstServicePoint.code, POINTS.PICKUP);
    assert.strictEqual(ride.finalServicePoint.code, POINTS.DESTINATION);
    assert.strictEqual(ride.route.distanceMeters, 2214);
    assert.ok(ride.completedAt);

    // The passenger rows are not read at all, so no name and no id can be here.
    const payload = JSON.stringify(ride);
    assert.ok(!payload.includes('Nusrat'));
    assert.ok(!payload.includes('passengers'));
    assert.ok(!payload.includes('members'));
  });

  it('pages deterministically, including when rows share a timestamp', async () => {
    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await completedTrip({ driver: jashim, passenger: [nusrat, rafiq, shirin, nusrat][index], cookie: jashimCookie });
    }

    // Force a shared `created_at` directly: the column is not frozen on the pool
    // the way a ride request's is, so this is the cheapest way to build the tie
    // the ORDER BY's second key exists for.
    await pool.query(`UPDATE ride_pools SET created_at = '2026-09-20T06:00:00Z'`);

    const walkThePages = async () => {
      const seen = [];

      for (let offset = 0; offset < 4; offset += 1) {
        // eslint-disable-next-line no-await-in-loop
        const page = await get(jashimCookie, `/drivers/me/rides?limit=1&offset=${offset}`);
        assert.strictEqual(page.body.pagination.total, 4);
        seen.push(page.body.data[0].poolId);
      }

      return seen;
    };

    const first = await walkThePages();
    const second = await walkThePages();

    assert.strictEqual(new Set(first).size, 4, 'four rows, four different pages');
    assert.deepStrictEqual(first, second, 'and the same order every time');
  });

  it('refuses a passenger, an anonymous caller and a malformed page', async () => {
    assert.strictEqual((await get(nusratCookie, '/drivers/me/rides')).status, 403);
    assert.strictEqual((await get(null, '/drivers/me/rides')).status, 401);
  });
});

describe('one of the driver\'s pools in detail', () => {
  it('reports the plan in the order it is driven, with the passengers', async () => {
    const first = await createPool({ driver: jashim, passenger: nusrat });
    const second = await joinPool({ driver: jashim, passenger: rafiq });
    await driveTheWholeTrip(first.poolId, jashimCookie);

    const response = await get(jashimCookie, `/drivers/me/rides/${first.poolId}`);

    assert.strictEqual(response.status, 200);
    const ride = response.body;

    assert.strictEqual(ride.poolId, first.poolId);
    assert.strictEqual(ride.status, 'COMPLETED');

    // Category 9: the stops are ordered, and a shared corner is two consecutive
    // stops at one service point rather than one merged stop.
    assert.deepStrictEqual(ride.stops.map((stop) => stop.sequence), [1, 2, 3, 4]);
    assert.deepStrictEqual(
      ride.stops.map((stop) => stop.stopType),
      ['PICKUP', 'PICKUP', 'DROPOFF', 'DROPOFF'],
    );
    assert.strictEqual(ride.stops[0].servicePoint.code, POINTS.PICKUP);
    assert.strictEqual(ride.stops[1].servicePoint.code, POINTS.PICKUP);
    assert.notStrictEqual(ride.stops[0].stopId, ride.stops[1].stopId);
    assert.strictEqual(ride.nextStop, null, 'every stop is finished');

    assert.strictEqual(ride.passengers.length, 2);
    assert.deepStrictEqual(
      ride.passengers.map((passenger) => passenger.displayName).sort(),
      ['Nusrat', 'Rafiq'],
    );
    assert.ok(ride.passengers.every((passenger) => passenger.pickedUpAt));
    assert.ok(ride.passengers.every((passenger) => passenger.droppedOffAt));

    assert.strictEqual(ride.passengerCount, 2);
    assert.ok(ride.departedAt && ride.startedAt && ride.completedAt);
    assert.deepStrictEqual(ride.allowedActions, [], 'a finished pool offers nothing');
  });

  it('reports the pool timeline, and never a passenger\'s ride events', async () => {
    const { request, poolId } = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });

    const ride = (await get(jashimCookie, `/drivers/me/rides/${poolId}`)).body;

    assert.ok(ride.timeline.length >= 5);
    assert.strictEqual(ride.timeline[0].eventType, 'POOL_CREATED');
    assert.ok(ride.timeline.some((entry) => entry.eventType === 'TRIP_COMPLETED'));
    assert.deepStrictEqual(
      ride.timeline.map((entry) => entry.sequence),
      ride.timeline.map((entry) => entry.sequence).sort((a, b) => a - b),
    );

    // The passenger's own log is a different record, and it is not read at all.
    const { rows } = await pool.query(
      `SELECT event_type FROM ride_events WHERE ride_request_id = $1::uuid`,
      [request.id],
    );
    assert.ok(rows.some((row) => row.event_type === 'PASSENGER_PICKED_UP'), 'her log exists');

    const payload = JSON.stringify(ride);
    for (const passengerEvent of ['PASSENGER_PICKED_UP', 'PASSENGER_FARE_ALLOCATED', 'RIDE_STARTED']) {
      assert.ok(!payload.includes(passengerEvent), `${passengerEvent} belongs to the passenger`);
    }

    // Every entry is a mapped sentence with a phase, not a raw audit row.
    for (const entry of ride.timeline) {
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

  it('reports the pool fare as a total, with no per-passenger amounts', async () => {
    const { poolId } = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });

    const ride = (await get(jashimCookie, `/drivers/me/rides/${poolId}`)).body;

    assert.deepStrictEqual(Object.keys(ride.fare).sort(), [
      'currency',
      'fareStatus',
      'finalized',
      'finalizedAt',
      'poolVersion',
      'totalPassengerFare',
    ]);
    assert.strictEqual(ride.fare.fareStatus, 'FINALIZED');
    assert.match(ride.fare.totalPassengerFare, /^\d+$/, 'a charged fare is a whole number of taka');

    // What the passenger was charged, per person, is not in the response.
    const payload = JSON.stringify(ride);
    for (const forbidden of [
      'acceptedSoloFare',
      'finalFare',
      'allocatedLegCost',
      'noIncreaseReduction',
      'allocations',
      'passengerProfile',
      'nusrat@example.com',
    ]) {
      assert.ok(!payload.includes(forbidden), `${forbidden} must not reach a driver`);
    }

    assert.ok(!payload.includes(nusrat.id) && !payload.includes(nusrat.passengerProfile.id));
  });

  it('answers 404 for another driver\'s pool, not 403', async () => {
    const theirs = await completedTrip({
      driver: other,
      passenger: shirin,
      cookie: otherCookie,
    });

    const asJashim = await get(jashimCookie, `/drivers/me/rides/${theirs.poolId}`);
    const unknown = await get(
      jashimCookie,
      '/drivers/me/rides/00000000-0000-4000-8000-000000000000',
    );

    // A 403 would tell one driver that another driver's pool id is real.
    assert.strictEqual(asJashim.status, 404);
    assert.strictEqual(unknown.status, 404);
    assert.deepStrictEqual(Object.keys(asJashim.body), Object.keys(unknown.body));
    assert.match(asJashim.body.error.message, /was not found$/);

    // And the other driver still has their own.
    assert.strictEqual((await get(otherCookie, `/drivers/me/rides/${theirs.poolId}`)).status, 200);
  });

  it('protects the nested resource from the wrong role and from nobody at all', async () => {
    const { poolId } = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });

    assert.strictEqual((await get(nusratCookie, `/drivers/me/rides/${poolId}`)).status, 403);
    assert.strictEqual((await get(null, `/drivers/me/rides/${poolId}`)).status, 401);
    assert.strictEqual((await get(jashimCookie, '/drivers/me/rides/not-a-uuid')).status, 400);
  });

  it('offers the next action while the trip is still running, and none once it is over', async () => {
    const { poolId } = await createPool({ driver: jashim, passenger: nusrat });

    const forming = (await get(jashimCookie, `/drivers/me/rides/${poolId}`)).body;
    assert.deepStrictEqual(forming.allowedActions, ['DEPART']);
    assert.strictEqual(forming.nextStop.sequence, 1);
    assert.strictEqual(forming.status, 'FORMING');

    const [pickupStop] = (await stopsOf(poolId)).filter((stop) => stop.stop_type === 'PICKUP');
    await post(jashimCookie, `/drivers/me/pools/${poolId}/depart`);
    await post(jashimCookie, `/drivers/me/pools/${poolId}/stops/${pickupStop.id}/arrive`);

    const arrived = (await get(jashimCookie, `/drivers/me/rides/${poolId}`)).body;
    assert.strictEqual(arrived.status, 'ARRIVED');
    assert.deepStrictEqual(arrived.allowedActions, ['PICKUP_PASSENGER']);
    assert.strictEqual(arrived.nextStop.status, 'ARRIVED');

    await driveTheWholeTrip(poolId, jashimCookie);

    const finished = (await get(jashimCookie, `/drivers/me/rides/${poolId}`)).body;
    assert.deepStrictEqual(finished.allowedActions, []);
    assert.strictEqual(finished.nextStop, null);
  });
});

describe('the current pool', () => {
  it('reports the live plan with the ordering the driver must follow', async () => {
    const first = await createPool({ driver: jashim, passenger: nusrat });
    const second = await joinPool({ driver: jashim, passenger: rafiq });

    const response = await get(jashimCookie, '/drivers/me/current-pool');

    assert.strictEqual(response.status, 200);
    const { pool } = response.body;

    assert.strictEqual(pool.poolId, first.poolId);
    assert.strictEqual(pool.stops.length, 4);
    assert.deepStrictEqual(pool.stops.map((stop) => stop.sequence), [1, 2, 3, 4]);
    assert.strictEqual(pool.nextStop.sequence, 1);
    assert.deepStrictEqual(pool.allowedActions, ['DEPART']);
    assert.strictEqual(pool.pricing.finalized, false, 'nothing is frozen before departure');
    assert.strictEqual(pool.members.length, 2);

    // The alias answers identically, so a caller written before the trip
    // milestone keeps working.
    const alias = await get(jashimCookie, '/drivers/me/pool');
    assert.deepStrictEqual(alias.body, response.body);

    // A second driver has no pool of their own to see here.
    assert.deepStrictEqual((await get(otherCookie, '/drivers/me/current-pool')).body, { pool: null });
  });

  it('carries no money, which the history detail does', async () => {
    const { poolId } = await createPool({ driver: jashim, passenger: nusrat });

    const payload = JSON.stringify((await get(jashimCookie, '/drivers/me/current-pool')).body);

    // The asymmetry is deliberate: while a driver can still decide where to go
    // next, what a passenger is paying must not be part of that decision.
    assert.doesNotMatch(payload, /"(fare|price|amount|cost|money|currency)[A-Za-z]*"\s*:/i);
    assert.ok(payload.includes('"finalized"'));

    await post(jashimCookie, `/drivers/me/pools/${poolId}/depart`);
    const afterDeparture = JSON.stringify(
      (await get(jashimCookie, '/drivers/me/current-pool')).body,
    );
    assert.doesNotMatch(afterDeparture, /"(fare|price|amount|cost|money|currency)[A-Za-z]*"\s*:/i);
  });
});

describe('availability decides dispatch (category 2)', () => {
  it('leaves an offline driver out of the search, and puts them back when they are online', async () => {
    // Nobody is online, so the request finds no driver and stays waiting.
    await goOfflineQuietly(jashim);
    const ignored = await requestRide(nusrat);
    const whenOffline = await dispatch.dispatchWaitingRequest({ rideRequestId: ignored.id });

    assert.strictEqual(whenOffline.dispatched, false, 'an offline driver is not a candidate');

    // Online at a nearby point, the same kind of request reaches them.
    await goOnline(jashim, POINTS.NEAR);
    const offered = await requestRide(rafiq);
    const whenOnline = await dispatch.dispatchWaitingRequest({ rideRequestId: offered.id });

    assert.strictEqual(whenOnline.dispatched, true);
    assert.strictEqual(whenOnline.driverProfileId, jashim.driverProfile.id);
  });

  it('re-enters the search from the place the last trip ended', async () => {
    // Completion releases the driver at the final drop-off's service point, so
    // their next dispatch is measured from where they actually are.
    const { poolId } = await completedTrip({
      driver: jashim,
      passenger: nusrat,
      cookie: jashimCookie,
    });

    const { rows } = await pool.query(
      `SELECT dp.status, sp.code
         FROM driver_profiles dp
         JOIN service_points sp ON sp.id = dp.current_service_point_id
        WHERE dp.id = $1::uuid`,
      [jashim.driverProfile.id],
    );

    assert.strictEqual(rows[0].status, 'AVAILABLE');
    assert.strictEqual(rows[0].code, POINTS.DESTINATION);

    const availability = await get(jashimCookie, '/drivers/me/availability');
    assert.strictEqual(availability.body.online, true);
    assert.strictEqual(availability.body.operationalStatus, 'AVAILABLE');
    assert.strictEqual(availability.body.servicePoint.code, POINTS.DESTINATION);

    assert.ok(poolId);
  });
});
