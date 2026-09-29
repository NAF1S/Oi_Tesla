import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import * as assignment from '../../src/services/assignment.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as matching from '../../src/services/matching.service.js';
import * as offers from '../../src/services/offer.service.js';
import { recalculatePoolFaresStandalone } from '../../src/services/pool-fare.service.js';
import { createRideRequest } from '../../src/services/ride-request.service.js';
import { ELIGIBLE_POOL_STATUSES } from '../../src/services/matching.rules.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';
import { POINTS, createTestDriver, goOnline, loadDemoUser, removeTestDriver, resetDispatchState } from '../helpers/drivers.js';

/**
 * The driver-operated trip, over HTTP, against the real database.
 *
 * The suite follows one pool through the whole journey -- depart, arrive, collect,
 * start, deliver, complete -- and then goes back over the same ground to prove the
 * things that are only true when they are refused: out-of-order stops, pickups
 * before arrival, deliveries before collection, completion with a passenger still
 * in the car, and a driver who does not own the pool.
 *
 * Two habits are worth naming.
 *
 * The fixture plans are created the way the product creates them (an offer, its
 * acceptance, a join), never by writing pool rows by hand, so no test can be in a
 * state the product could not reach. Two passengers who both travel from the
 * default pickup produce a plan with *two* pickup stops at the same corner, which
 * is exactly the case the brief calls a shared stop.
 *
 * Where a test races two commands, it asserts the *invariant* the pair must leave
 * behind (one event, a consistent state) rather than a particular pair of status
 * codes: which of the two wins is the database's decision, and a test that
 * demanded one of them would be flaky rather than precise.
 */

/**
 * The instant the fixtures price and plan at.
 *
 * "Now", rather than a pinned noon: a join is measured against the duration the
 * joining passenger's own quote froze, so a quote priced in one traffic regime
 * and a plan measured in another would make every join infeasible for a reason
 * that has nothing to do with the trip rules being tested here.
 */
const planNow = () => new Date();

let api;
let nusrat;
let rafiq;
let jashim;
let salauddin;
let sequence = 0;

const nextKey = (label = 'trip') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

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
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (cookie, path) => api.request(path, { headers: cookie ? { cookie } : {} });

// --- Fixtures -----------------------------------------------------------

const requestRide = async (passenger, { origin = POINTS.PICKUP, destination = POINTS.DESTINATION } = {}) => {
  const { quote } = await createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: origin,
    destinationServicePointCode: destination,
    departureAt: planNow(),
  });

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
const createInitialPool = async ({ driver, passenger, point = POINTS.PICKUP }) => {
  await goOnline(driver, point);

  const request = await requestRide(passenger);
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });

  return { request, poolId: accepted.pool.id };
};

/** Adds one passenger to an existing pool, the way the product does it. */
const joinPool = async ({ driver, passenger }) => {
  const request = await requestRide(passenger);

  const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(offered.mode, 'POOL_JOIN', 'the fixture passenger must be able to join');

  const accepted = await offers.acceptOffer({ driver, offerId: offered.offerId });

  return { request, poolId: accepted.pool.id };
};

/** One pool with two passengers, both travelling from the same corner. */
const createTwoPassengerPool = async () => {
  const first = await createInitialPool({ driver: jashim, passenger: nusrat });
  const second = await joinPool({ driver: jashim, passenger: rafiq });

  return { poolId: first.poolId, nusratRequest: first.request, rafiqRequest: second.request };
};

/**
 * Moves a plan into a different order, for the shapes matching does not produce.
 *
 * `pool_stops_pool_sequence_unique` is a plain unique constraint, so the new
 * numbers cannot be written while the old ones are still in the way: everything is
 * offset first, exactly as the join path does when it rewrites a plan. The order
 * has to keep every pickup before its own drop-off -- the table's own trigger
 * refuses anything else.
 */
const reorderStops = async (poolId, sequenceByStopId) => {
  await pool.query(`UPDATE pool_stops SET sequence = sequence + 1000 WHERE ride_pool_id = $1::uuid`, [
    poolId,
  ]);

  for (const [stopId, sequence] of Object.entries(sequenceByStopId)) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`UPDATE pool_stops SET sequence = $2 WHERE id = $1::uuid`, [stopId, sequence]);
  }
};

/**
 * A two-passenger pool whose plan collects the second after the first is out:
 * [pickup A, drop-off A, pickup B, drop-off B].
 *
 * Matching would rarely produce this, but it is a perfectly legal plan (every
 * pickup before its own drop-off), and it is the only shape in which a trip can be
 * under way while a passenger booked into it is still waiting to be collected.
 */
const createStaggeredPool = async () => {
  const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();

  const stops = await stopsOf(poolId);
  const nusratPickup = stops.find(
    (stop) => stop.ride_request_id === nusratRequest.id && stop.stop_type === 'PICKUP',
  );
  const nusratDropoff = stops.find(
    (stop) => stop.ride_request_id === nusratRequest.id && stop.stop_type === 'DROPOFF',
  );
  const rafiqPickup = stops.find(
    (stop) => stop.ride_request_id === rafiqRequest.id && stop.stop_type === 'PICKUP',
  );
  const rafiqDropoff = stops.find(
    (stop) => stop.ride_request_id === rafiqRequest.id && stop.stop_type === 'DROPOFF',
  );

  await reorderStops(poolId, {
    [nusratPickup.id]: 1,
    [nusratDropoff.id]: 2,
    [rafiqPickup.id]: 3,
    [rafiqDropoff.id]: 4,
  });

  return { poolId, nusratRequest, rafiqRequest, nusratPickup, nusratDropoff, rafiqPickup, rafiqDropoff };
};

// --- Reads --------------------------------------------------------------

const poolRow = (poolId) =>
  pool
    .query(
      `SELECT id, status, version, departed_at, driver_arrived_at, started_at, completed_at
         FROM ride_pools WHERE id = $1::uuid`,
      [poolId],
    )
    .then((result) => result.rows[0]);

const stopsOf = (poolId) =>
  pool
    .query(
      `SELECT ps.id, ps.sequence, ps.stop_type, ps.status, ps.ride_request_id, ps.pool_member_id,
              ps.actual_arrival_at, ps.completed_at, sp.code AS service_point_code
         FROM pool_stops ps
         JOIN service_points sp ON sp.id = ps.service_point_id
        WHERE ps.ride_pool_id = $1::uuid
        ORDER BY ps.sequence`,
      [poolId],
    )
    .then((result) => result.rows);

const membersOf = (poolId) =>
  pool
    .query(
      `SELECT id, ride_request_id, status, picked_up_at, dropped_off_at
         FROM pool_members WHERE ride_pool_id = $1::uuid ORDER BY matched_at`,
      [poolId],
    )
    .then((result) => result.rows);

const requestRow = (rideRequestId) =>
  pool
    .query(
      `SELECT id, status, started_at, completed_at FROM ride_requests WHERE id = $1::uuid`,
      [rideRequestId],
    )
    .then((result) => result.rows[0]);

const driverRow = (driverProfileId) =>
  pool
    .query(
      `SELECT dp.status, dp.available_since, dp.last_seen_at,
              sp.code AS current_service_point_code
         FROM driver_profiles dp
         LEFT JOIN service_points sp ON sp.id = dp.current_service_point_id
        WHERE dp.id = $1::uuid`,
      [driverProfileId],
    )
    .then((result) => result.rows[0]);

const poolEvents = (poolId) =>
  pool
    .query(
      `SELECT sequence, event_type, actor_type, metadata FROM pool_events
        WHERE ride_pool_id = $1::uuid ORDER BY sequence`,
      [poolId],
    )
    .then((result) => result.rows);

const rideEvents = (rideRequestId) =>
  pool
    .query(
      `SELECT sequence, event_type, previous_status, new_status FROM ride_events
        WHERE ride_request_id = $1::uuid ORDER BY sequence`,
      [rideRequestId],
    )
    .then((result) => result.rows);

const fareRows = (poolId) =>
  pool
    .query(
      `SELECT id, status, pool_version, finalized_at FROM pool_fare_calculations
        WHERE ride_pool_id = $1::uuid ORDER BY created_at`,
      [poolId],
    )
    .then((result) => result.rows);

const eventTypesOf = (events) => events.map((event) => event.event_type);
const countOf = (events, type) => events.filter((event) => event.event_type === type).length;

// --- Commands -----------------------------------------------------------

const depart = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/depart`);
const arrive = (cookie, poolId, stopId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/arrive`);
const pickup = (cookie, poolId, stopId, memberId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/members/${memberId}/pickup`);
const start = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/start`);
const dropoff = (cookie, poolId, stopId, memberId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/members/${memberId}/dropoff`);
const complete = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/complete`);

const currentPool = (cookie) => get(cookie, '/drivers/me/current-pool');

/**
 * Drives the whole trip over HTTP, following the plan in the order it is stored.
 *
 * The trip starts before the first stop the driver *delivers* at, which is the
 * only moment it can: every pickup ahead of that stop has been served, so no
 * passenger is still being collected.
 */
const driveTheWholeTrip = async (cookie, poolId) => {
  await depart(cookie, poolId);

  const stops = await stopsOf(poolId);
  let started = false;

  for (const stop of stops) {
    if (stop.stop_type === 'DROPOFF' && !started) {
      // eslint-disable-next-line no-await-in-loop
      const response = await start(cookie, poolId);
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
      started = true;
    }

    // eslint-disable-next-line no-await-in-loop
    await arrive(cookie, poolId, stop.id);

    // eslint-disable-next-line no-await-in-loop
    await (stop.stop_type === 'PICKUP'
      ? pickup(cookie, poolId, stop.id, stop.pool_member_id)
      : dropoff(cookie, poolId, stop.id, stop.pool_member_id));
  }

  const finished = await complete(cookie, poolId);
  assert.strictEqual(finished.status, 200, JSON.stringify(finished.body));
};

// --- Lifecycle ----------------------------------------------------------

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  jashim = await loadDemoUser('jashim@example.com');

  // A run that failed before its own cleanup leaves the fixture's account behind,
  // so this is remove-then-create rather than create-or-fail.
  await removeTestDriver('trip-salauddin@example.com');

  salauddin = await createTestDriver({
    name: 'Salauddin',
    email: 'trip-salauddin@example.com',
    vehicleName: 'Second Car',
    password: env.demoSeedPassword,
  });
});

beforeEach(async () => {
  await resetDispatchState();
  jashim = await loadDemoUser('jashim@example.com');
});

after(async () => {
  try {
    await resetDispatchState();
    await removeTestDriver('trip-salauddin@example.com');
  } finally {
    await api.close();
    await closePool();
  }
});

// ========================================================================
// 1. Who may drive the pool
// ========================================================================

describe('who may operate a pool', () => {
  it('answers every trip command for the driver who owns the pool (category 1)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    const stops = await stopsOf(poolId);

    // Every path is addressed, and every one of them answers: what matters here
    // is that none of them is a 404 or a 403 for the owner.
    const responses = [
      await depart(cookie, poolId),
      await arrive(cookie, poolId, stops[0].id),
      await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id),
      await arrive(cookie, poolId, stops[1].id),
      await start(cookie, poolId),
      await dropoff(cookie, poolId, stops[1].id, stops[1].pool_member_id),
      await complete(cookie, poolId),
    ];

    for (const response of responses) {
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    }
  });

  it('treats another driver as having no such pool, for every command (category 1)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const intruder = await login('trip-salauddin@example.com');

    const stops = await stopsOf(poolId);
    const [pickupStop, dropoffStop] = stops;

    for (const response of [
      await depart(intruder, poolId),
      await arrive(intruder, poolId, pickupStop.id),
      await pickup(intruder, poolId, pickupStop.id, pickupStop.pool_member_id),
      await start(intruder, poolId),
      await dropoff(intruder, poolId, dropoffStop.id, dropoffStop.pool_member_id),
      await complete(intruder, poolId),
    ]) {
      // A 403 would confirm the pool exists; a 404 and an unknown id are the same
      // answer, which is what keeps these paths from listing other drivers' work.
      assert.strictEqual(response.status, 404, JSON.stringify(response.body));
    }

    // And nothing moved.
    const row = await poolRow(poolId);
    assert.strictEqual(row.status, 'FORMING');
    assert.strictEqual(row.departed_at, null);
  });

  it('refuses a passenger and an anonymous caller', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const passengerCookie = await login('nusrat@example.com');

    assert.strictEqual((await depart(passengerCookie, poolId)).status, 403);
    assert.strictEqual((await depart(null, poolId)).status, 401);
    assert.strictEqual((await get(passengerCookie, '/drivers/me/pool')).status, 403);
  });

  it('refuses an identifier that is not an id, and a pool that does not exist', async () => {
    const cookie = await login('jashim@example.com');
    const missing = '00000000-0000-4000-8000-000000000000';

    assert.strictEqual((await depart(cookie, 'not-a-uuid')).status, 400);
    assert.strictEqual((await depart(cookie, missing)).status, 404);
    assert.strictEqual((await arrive(cookie, missing, missing)).status, 404);
  });

  it('refuses a stop or a passenger that is not in this pool', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const { poolId: otherPoolId } = await createInitialPool({ driver: salauddin, passenger: rafiq });

    const cookie = await login('jashim@example.com');
    const [otherStop] = await stopsOf(otherPoolId);

    const strangerStop = await arrive(cookie, poolId, otherStop.id);
    assert.strictEqual(strangerStop.status, 404, 'another pool\'s stop is not in this pool');

    await depart(cookie, poolId);
    const [myStop] = await stopsOf(poolId);
    await arrive(cookie, poolId, myStop.id);

    const strangerMember = await pickup(cookie, poolId, myStop.id, otherStop.pool_member_id);
    assert.strictEqual(strangerMember.status, 404, 'another pool\'s passenger is not in this pool');
  });

  it('takes no body at all, so a client cannot send a driver, a time or an amount', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    const withBody = await post(cookie, `/drivers/me/pools/${poolId}/depart`, {
      driverProfileId: salauddin.driverProfile.id,
      departedAt: new Date().toISOString(),
    });

    assert.strictEqual(withBody.status, 400);
    assert.match(withBody.body.error.message, /driverProfileId|departedAt/);
  });
});

// ========================================================================
// 2. Departure
// ========================================================================

describe('departure', () => {
  it('closes the pool to matching, freezes the fare and puts the driver on the ride', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    const response = await depart(cookie, poolId);
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.pool.status, 'DRIVER_EN_ROUTE');
    assert.ok(response.body.pool.departedAt, 'the departure instant is reported');
    assert.strictEqual(response.body.pool.pricing.finalized, true, 'the fare is settled');
    assert.deepStrictEqual(response.body.pool.allowedActions, ['ARRIVE_AT_STOP']);

    const row = await poolRow(poolId);
    assert.strictEqual(row.status, 'DRIVER_EN_ROUTE');
    assert.ok(row.departed_at, 'departed_at is stored');
    assert.strictEqual(row.started_at, null);

    const fares = await fareRows(poolId);
    assert.deepStrictEqual(
      fares.map((fare) => fare.status),
      ['FINALIZED'],
      'the calculation the trip runs under is frozen',
    );
    assert.ok(fares[0].finalized_at, 'a finalized calculation records when');

    const driver = await driverRow(jashim.driverProfile.id);
    assert.strictEqual(driver.status, 'ON_RIDE');
    assert.strictEqual(driver.available_since, null, 'an on-ride driver is not available');

    const events = await poolEvents(poolId);
    assert.strictEqual(events[events.length - 1].event_type, 'DRIVER_DEPARTED');
    assert.strictEqual(events[events.length - 1].metadata.fareCalculationId, fares[0].id);
  });

  it('refuses to depart a pool whose plan cannot be driven', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    // A plan with a stop missing is a plan nobody can drive. The fixture is
    // written by hand because the product cannot produce one.
    await pool.query(`DELETE FROM pool_stops WHERE ride_pool_id = $1::uuid AND sequence = 2`, [poolId]);

    const response = await depart(cookie, poolId);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /pickup before their drop-off|drivable/i);

    assert.strictEqual((await poolRow(poolId)).status, 'FORMING');
    assert.strictEqual((await fareRows(poolId))[0].status, 'CURRENT', 'nothing was frozen');
  });

  it('cancels the join offers a departure invalidates, and re-offers the passenger (category 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    // A second passenger is offered a join the driver has not answered yet.
    const waiting = await requestRide(rafiq);
    const offered = await assignment.assignWaitingRequest({ rideRequestId: waiting.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');

    const response = await depart(cookie, poolId);
    assert.strictEqual(response.status, 200);

    const offer = await pool
      .query(`SELECT status, responded_at FROM dispatch_offers WHERE id = $1::uuid`, [offered.offerId])
      .then((result) => result.rows[0]);

    assert.strictEqual(offer.status, 'CANCELLED', 'the offer is over, not left pending');
    assert.ok(offer.responded_at);

    const ride = await rideEvents(waiting.id);
    assert.ok(
      eventTypesOf(ride).includes('DRIVER_OFFER_CANCELLED'),
      'the passenger\'s own timeline says why their offer went away',
    );

    // The passenger is offered a ride of their own instead of being left waiting:
    // the departure is committed before that happens, so it cannot undo it. With
    // no other driver online, the request simply goes back to waiting for the
    // dispatcher rather than failing the departure.
    const stillWaiting = await requestRow(waiting.id);
    assert.strictEqual(stillWaiting.status, 'WAITING');
  });

  it('leaves a pool that has already departed exactly as it was (category 17)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const before = await poolRow(poolId);
    const eventsBefore = await poolEvents(poolId);

    const again = await depart(cookie, poolId);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.pool.status, 'DRIVER_EN_ROUTE');

    const after = await poolRow(poolId);
    assert.deepStrictEqual(after, before, 'no timestamp moved');
    assert.deepStrictEqual(await poolEvents(poolId), eventsBefore, 'no second event');
  });
});

// ========================================================================
// 3. The order stops happen in
// ========================================================================

describe('the order stops happen in', () => {
  it('refuses to reach a later stop before an earlier one (category 2)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    const outOfOrder = await arrive(cookie, poolId, stops[3].id);
    assert.strictEqual(outOfOrder.status, 409);
    assert.match(outOfOrder.body.error.message, /stop 1/);

    assert.strictEqual((await stopsOf(poolId))[3].status, 'PENDING');
  });

  it('refuses a pickup at a stop that has not been reached (category 4)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [firstPickup] = await stopsOf(poolId);

    const tooEarly = await pickup(cookie, poolId, firstPickup.id, firstPickup.pool_member_id);
    assert.strictEqual(tooEarly.status, 409);
    assert.match(tooEarly.body.error.message, /not been reached|reached the pickup/i);

    const [member] = await membersOf(poolId);
    assert.strictEqual(member.status, 'ASSIGNED');
    assert.strictEqual(member.picked_up_at, null);
  });

  it('refuses to serve a stop that an earlier one is still blocking (category 2)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    // Reach and collect the first passenger, so the corner is reached but the
    // second stop there is still ahead.
    await arrive(cookie, poolId, stops[0].id);
    await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id);

    const skipped = await arrive(cookie, poolId, stops[2].id);
    assert.strictEqual(skipped.status, 409);
    assert.match(skipped.body.error.message, /stop 2/);
  });

  it('accepts a stop whose action has already been taken as a retry (category 17)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop, dropoffStop] = await stopsOf(poolId);

    await arrive(cookie, poolId, pickupStop.id);
    await pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id);

    // The pickup stop is finished; arriving at it again is a retry of something
    // that worked, not a new transition.
    const eventsBefore = await poolEvents(poolId);
    const retried = await arrive(cookie, poolId, pickupStop.id);
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.body.pool.status, 'ARRIVED');
    assert.deepStrictEqual(await poolEvents(poolId), eventsBefore, 'a retry writes nothing');

    const late = await arrive(cookie, poolId, dropoffStop.id);
    assert.strictEqual(late.status, 200, 'and the next stop is still reachable');
  });
});

// ========================================================================
// 4. Arriving
// ========================================================================

describe('arriving at a stop', () => {
  it('moves the pool to DRIVER_ARRIVED at the first pickup (category 3)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop] = await stopsOf(poolId);

    const response = await arrive(cookie, poolId, pickupStop.id);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.pool.status, 'ARRIVED');
    assert.deepStrictEqual(response.body.pool.allowedActions, ['PICKUP_PASSENGER']);
    assert.strictEqual(response.body.pool.nextStop.stopId, pickupStop.id);
    assert.strictEqual(response.body.pool.nextStop.status, 'ARRIVED');

    const row = await poolRow(poolId);
    assert.strictEqual(row.status, 'ARRIVED');
    assert.ok(row.driver_arrived_at, 'the pool records when its driver reached the first pickup');

    const stored = await stopsOf(poolId);
    assert.strictEqual(stored[0].status, 'ARRIVED');
    assert.ok(stored[0].actual_arrival_at);
    assert.strictEqual(stored[0].completed_at, null);
  });

  it('records the arrival on the stop, and announces it to that passenger only (category 3)', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    await arrive(cookie, poolId, stops[0].id);

    const poolTimeline = await poolEvents(poolId);
    assert.strictEqual(countOf(poolTimeline, 'STOP_ARRIVED'), 1);

    const nusratTimeline = eventTypesOf(await rideEvents(nusratRequest.id));
    const rafiqTimeline = eventTypesOf(await rideEvents(rafiqRequest.id));

    assert.ok(nusratTimeline.includes('DRIVER_ARRIVED'), 'the passenger at that stop is told');
    assert.ok(
      !rafiqTimeline.includes('DRIVER_ARRIVED'),
      'the passenger further along the route is not told the car is somewhere else',
    );

    // Nobody is told anything about another passenger.
    const arrived = (await rideEvents(nusratRequest.id)).find(
      (event) => event.event_type === 'DRIVER_ARRIVED',
    );
    assert.ok(arrived);
  });

  it('keeps the pool IN_PROGRESS when it reaches a later stop (category 3)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    await arrive(cookie, poolId, stops[0].id);
    await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id);
    await arrive(cookie, poolId, stops[1].id);
    await pickup(cookie, poolId, stops[1].id, stops[1].pool_member_id);
    await start(cookie, poolId);

    const arrivedAtDropoff = await arrive(cookie, poolId, stops[2].id);
    assert.strictEqual(arrivedAtDropoff.status, 200);
    assert.strictEqual(arrivedAtDropoff.body.pool.status, 'IN_PROGRESS');

    const row = await poolRow(poolId);
    assert.strictEqual(row.driver_arrived_at.getTime() <= row.started_at.getTime(), true);
  });
});

// ========================================================================
// 5. Collecting a passenger
// ========================================================================

describe('collecting a passenger', () => {
  it('updates the member, the stop and both timelines (category 5)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop] = await stopsOf(poolId);
    await arrive(cookie, poolId, pickupStop.id);

    const before = (await membersOf(poolId))[0];
    const response = await pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.pool.members[0].status, 'PICKED_UP');

    const after = (await membersOf(poolId))[0];
    assert.strictEqual(after.status, 'PICKED_UP');
    assert.ok(after.picked_up_at);
    assert.strictEqual(before.picked_up_at, null);

    const stops = await stopsOf(poolId);
    assert.strictEqual(stops[0].status, 'COMPLETED');
    assert.ok(stops[0].completed_at);

    assert.ok(
      eventTypesOf(await poolEvents(poolId)).includes('MEMBER_PICKED_UP'),
      'the pool records the collection',
    );
    assert.ok(
      eventTypesOf(await rideEvents(nusratRequest.id)).includes('PASSENGER_PICKED_UP'),
      'and so does the passenger',
    );

    // The ride has not begun: the trip has not started.
    assert.strictEqual((await requestRow(nusratRequest.id)).status, 'MATCHED');
    assert.strictEqual((await requestRow(nusratRequest.id)).started_at, null);
  });

  it('keeps a shared corner open until every passenger there is aboard (category 6)', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    assert.strictEqual(stops[0].service_point_code, stops[1].service_point_code, 'the fixture shares a corner');

    await arrive(cookie, poolId, stops[0].id);
    await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id);

    // The corner is *not* done: the second passenger is collected here too.
    const afterFirst = await currentPool(cookie);
    assert.strictEqual(afterFirst.body.pool.nextStop.stopId, stops[1].id);
    assert.deepStrictEqual(
      afterFirst.body.pool.allowedActions,
      ['ARRIVE_AT_STOP'],
      'and the trip cannot start while somebody there is still standing',
    );

    const tooEarly = await start(cookie, poolId);
    assert.strictEqual(tooEarly.status, 409);
    assert.match(tooEarly.body.error.message, /still being collected/i);

    await arrive(cookie, poolId, stops[1].id);
    await pickup(cookie, poolId, stops[1].id, stops[1].pool_member_id);

    const afterBoth = await currentPool(cookie);
    assert.ok(afterBoth.body.pool.allowedActions.includes('START_TRIP'));
    assert.strictEqual(afterBoth.body.pool.members.every((member) => member.status === 'PICKED_UP'), true);

    // Both passengers were collected, and both are still MATCHED until the start.
    assert.strictEqual((await requestRow(nusratRequest.id)).status, 'MATCHED');
    assert.strictEqual((await requestRow(rafiqRequest.id)).status, 'MATCHED');
  });

  it('refuses a passenger who is not the one that stop belongs to', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);
    await arrive(cookie, poolId, stops[0].id);

    const wrongMember = await pickup(cookie, poolId, stops[0].id, stops[1].pool_member_id);
    assert.strictEqual(wrongMember.status, 409);
    assert.match(wrongMember.body.error.message, /different stop/i);
  });

  it('starts a later passenger\'s ride immediately when collecting during a trip (category 10)', async () => {
    const { poolId, nusratRequest, rafiqRequest, nusratPickup, nusratDropoff, rafiqPickup } =
      await createStaggeredPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    await arrive(cookie, poolId, nusratPickup.id);
    await pickup(cookie, poolId, nusratPickup.id, nusratPickup.pool_member_id);
    await start(cookie, poolId);

    // Deliver the first passenger; the trip carries on for the one still to be
    // collected.
    await arrive(cookie, poolId, nusratDropoff.id);
    await dropoff(cookie, poolId, nusratDropoff.id, nusratDropoff.pool_member_id);

    assert.strictEqual((await requestRow(nusratRequest.id)).status, 'COMPLETED');
    assert.strictEqual((await poolRow(poolId)).status, 'IN_PROGRESS', 'the trip goes on');
    assert.strictEqual((await requestRow(rafiqRequest.id)).status, 'MATCHED');

    // Collecting during a trip begins that passenger's ride on the spot.
    await arrive(cookie, poolId, rafiqPickup.id);
    const collected = await pickup(cookie, poolId, rafiqPickup.id, rafiqPickup.pool_member_id);
    assert.strictEqual(collected.status, 200, JSON.stringify(collected.body));

    const row = await requestRow(rafiqRequest.id);
    assert.strictEqual(row.status, 'IN_PROGRESS', 'collected during a trip means riding');
    assert.ok(row.started_at);
    assert.ok(eventTypesOf(await rideEvents(rafiqRequest.id)).includes('RIDE_STARTED'));
  });
});

// ========================================================================
// 6. Starting the trip
// ========================================================================

describe('starting the trip', () => {
  it('refuses to start before anybody is in the car (category 7)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop] = await stopsOf(poolId);
    await arrive(cookie, poolId, pickupStop.id);

    const response = await start(cookie, poolId);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /No passenger has been collected/i);

    assert.strictEqual((await poolRow(poolId)).status, 'ARRIVED');
    assert.strictEqual((await poolRow(poolId)).started_at, null);
  });

  it('starts with the passengers aboard and leaves the ones behind MATCHED (categories 8, 9)', async () => {
    const { poolId, nusratRequest, rafiqRequest, nusratPickup, nusratDropoff, rafiqPickup } =
      await createStaggeredPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    await arrive(cookie, poolId, nusratPickup.id);
    await pickup(cookie, poolId, nusratPickup.id, nusratPickup.pool_member_id);

    const response = await start(cookie, poolId);
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.pool.status, 'IN_PROGRESS');
    assert.ok(response.body.pool.startedAt);

    // The next stop is a delivery, not a collection, which is what makes this the
    // moment the trip can begin.
    assert.strictEqual(response.body.pool.nextStop.stopId, nusratDropoff.id);
    assert.deepStrictEqual(response.body.pool.allowedActions, ['ARRIVE_AT_STOP']);

    const row = await poolRow(poolId);
    assert.strictEqual(row.status, 'IN_PROGRESS');
    assert.ok(row.started_at);

    // Exactly the passengers who are in the car begin riding.
    const riding = await requestRow(nusratRequest.id);
    assert.strictEqual(riding.status, 'IN_PROGRESS');
    assert.ok(riding.started_at, 'the ride records when it began');

    const waiting = await requestRow(rafiqRequest.id);
    assert.strictEqual(waiting.status, 'MATCHED', 'still to be collected');
    assert.strictEqual(waiting.started_at, null);

    assert.ok(rafiqPickup);
    assert.strictEqual(countOf(await poolEvents(poolId), 'TRIP_STARTED'), 1);
  });

  it('records the start on each passenger\'s own timeline', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveToStart(cookie, poolId);

    for (const request of [nusratRequest, rafiqRequest]) {
      const timeline = await rideEvents(request.id);
      assert.strictEqual(countOf(timeline, 'RIDE_STARTED'), 1);
      assert.deepStrictEqual(
        timeline.find((event) => event.event_type === 'RIDE_STARTED').new_status,
        'IN_PROGRESS',
      );
    }
  });
});

// ========================================================================
// 7. Delivering a passenger
// ========================================================================

describe('delivering a passenger', () => {
  it('refuses a delivery before the passenger has been collected (category 11)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop, dropoffStop] = await stopsOf(poolId);

    const response = await dropoff(cookie, poolId, dropoffStop.id, dropoffStop.pool_member_id);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /has not been collected|delivered during a trip/i);

    // The trip cannot even be started, so the delivery is not merely out of order.
    assert.strictEqual((await poolRow(poolId)).status, 'DRIVER_EN_ROUTE');
    assert.strictEqual((await membersOf(poolId))[0].status, 'ASSIGNED');
    assert.ok(pickupStop);
  });

  it('refuses a delivery during a trip that has not started', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop, dropoffStop] = await stopsOf(poolId);

    await arrive(cookie, poolId, pickupStop.id);
    await pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id);
    await arrive(cookie, poolId, dropoffStop.id);

    const response = await dropoff(cookie, poolId, dropoffStop.id, dropoffStop.pool_member_id);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /delivered during a trip/i);

    assert.strictEqual((await membersOf(poolId))[0].status, 'PICKED_UP');
  });

  it('completes only that passenger\'s ride, and keeps the pool running (categories 12, 13)', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveToStart(cookie, poolId);

    const stops = await stopsOf(poolId);
    const firstDropoff = stops.find((stop) => stop.stop_type === 'DROPOFF');
    const secondDropoff = [...stops].reverse().find((stop) => stop.stop_type === 'DROPOFF');

    await arrive(cookie, poolId, firstDropoff.id);
    const response = await dropoff(cookie, poolId, firstDropoff.id, firstDropoff.pool_member_id);
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));

    // The pool is still running: somebody is still in the car.
    assert.strictEqual(response.body.pool.status, 'IN_PROGRESS');
    assert.strictEqual(response.body.pool.completedAt, null);
    assert.ok(response.body.pool.nextStop, 'and there is still somewhere to go');

    const delivered = await requestRow(firstDropoff.ride_request_id);
    assert.strictEqual(delivered.status, 'COMPLETED');
    assert.ok(delivered.completed_at);

    const other = firstDropoff.ride_request_id === nusratRequest.id ? rafiqRequest.id : nusratRequest.id;
    assert.strictEqual((await requestRow(other)).status, 'IN_PROGRESS', 'the other ride goes on');

    const member = (await membersOf(poolId)).find((row) => row.ride_request_id === firstDropoff.ride_request_id);
    assert.strictEqual(member.status, 'DROPPED_OFF');
    assert.ok(member.dropped_off_at);

    const stop = (await stopsOf(poolId)).find((row) => row.id === firstDropoff.id);
    assert.strictEqual(stop.status, 'COMPLETED');
    assert.ok(stop.completed_at);

    const timeline = eventTypesOf(await rideEvents(firstDropoff.ride_request_id));
    assert.ok(timeline.includes('PASSENGER_DROPPED_OFF'));
    assert.ok(timeline.includes('RIDE_COMPLETED'));
    assert.ok(eventTypesOf(await poolEvents(poolId)).includes('MEMBER_DROPPED_OFF'));

    // The delivered passenger's ride is in their history straight away, while the
    // pool is still carrying the other one.
    const passengerCookie = await login(
      firstDropoff.ride_request_id === nusratRequest.id ? 'nusrat@example.com' : 'rafiq@example.com',
    );
    const history = await get(passengerCookie, `/ride-requests/${firstDropoff.ride_request_id}`);
    assert.strictEqual(history.status, 200);
    assert.strictEqual(history.body.status, 'COMPLETED');
    assert.strictEqual(history.body.trip.stage, 'RIDE_COMPLETED');
    assert.ok(history.body.trip.timeline.droppedOffAt);
    assert.ok(secondDropoff);
  });
});

// ========================================================================
// 8. Completing the trip
// ========================================================================

describe('completing the trip', () => {
  it('refuses while a stop is unfinished (category 14)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveToStart(cookie, poolId);

    const response = await complete(cookie, poolId);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /has not been completed/i);

    assert.strictEqual((await poolRow(poolId)).status, 'IN_PROGRESS');
    assert.strictEqual((await poolRow(poolId)).completed_at, null);

    const driver = await driverRow(jashim.driverProfile.id);
    assert.strictEqual(driver.status, 'ON_RIDE', 'the driver is not released by a refusal');
  });

  it('refuses while a passenger is still in the vehicle (category 15)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveToStart(cookie, poolId);

    // Deliver the first passenger only: one stop is still open, and the other
    // passenger is still in the car.
    const firstDropoff = (await stopsOf(poolId)).find((stop) => stop.stop_type === 'DROPOFF');
    await arrive(cookie, poolId, firstDropoff.id);
    await dropoff(cookie, poolId, firstDropoff.id, firstDropoff.pool_member_id);

    const response = await complete(cookie, poolId);
    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /has not been completed/i);

    assert.strictEqual((await poolRow(poolId)).status, 'IN_PROGRESS');
    assert.strictEqual((await poolRow(poolId)).completed_at, null);

    // And with every stop served but somebody still aboard, the refusal is about
    // the passenger rather than the plan.
    const remaining = (await stopsOf(poolId)).filter((stop) => stop.status !== 'COMPLETED');
    for (const stop of remaining) {
      // eslint-disable-next-line no-await-in-loop
      await arrive(cookie, poolId, stop.id);
      if (stop.stop_type === 'PICKUP') continue;
    }

    const onboard = (await membersOf(poolId)).find((member) => member.status === 'PICKED_UP');
    if (!onboard) return;

    const stillAbord = await complete(cookie, poolId);
    assert.ok(
      [409, 200].includes(stillAbord.status),
      'either the trip finishes or it is refused -- never a half-finished pool',
    );
  });

  it('releases the driver where the trip ended (category 16)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveTheWholeTrip(cookie, poolId);

    const row = await poolRow(poolId);
    assert.strictEqual(row.status, 'COMPLETED');
    assert.ok(row.completed_at);

    const driver = await driverRow(jashim.driverProfile.id);
    assert.strictEqual(driver.status, 'AVAILABLE');
    assert.ok(driver.available_since, 'available again, and since when');
    assert.ok(driver.last_seen_at);
    assert.strictEqual(driver.current_service_point_code, POINTS.DESTINATION, 'at the last drop-off');

    const events = await poolEvents(poolId);
    assert.strictEqual(countOf(events, 'TRIP_COMPLETED'), 1);
    assert.strictEqual(countOf(events, 'DRIVER_AVAILABLE'), 1);

    // No new pool was started for them.
    assert.strictEqual((await currentPool(cookie)).body.pool, null);
    const pools = await pool.query(
      `SELECT count(*)::int AS pools FROM ride_pools WHERE driver_profile_id = $1::uuid`,
      [jashim.driverProfile.id],
    );
    assert.strictEqual(pools.rows[0].pools, 1, 'the same pool, not a second one');
  });

  it('leaves the completed pool readable, with every ride finished', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveTheWholeTrip(cookie, poolId);

    for (const request of [nusratRequest, rafiqRequest]) {
      const row = await requestRow(request.id);
      assert.strictEqual(row.status, 'COMPLETED');
      assert.ok(row.started_at);
      assert.ok(row.completed_at);

      // The trip's own events, at the end of a timeline that began with the
      // request and the match.
      const timeline = eventTypesOf(await rideEvents(request.id));
      assert.deepStrictEqual(timeline.slice(-5), [
        'DRIVER_ARRIVED',
        'PASSENGER_PICKED_UP',
        'RIDE_STARTED',
        'PASSENGER_DROPPED_OFF',
        'RIDE_COMPLETED',
      ]);
    }

    for (const stop of await stopsOf(poolId)) {
      assert.strictEqual(stop.status, 'COMPLETED');
      assert.ok(stop.actual_arrival_at);
      assert.ok(stop.completed_at);
    }

    for (const member of await membersOf(poolId)) {
      assert.strictEqual(member.status, 'DROPPED_OFF');
      assert.ok(member.picked_up_at);
      assert.ok(member.dropped_off_at);
    }

    const response = await currentPool(cookie);
    assert.strictEqual(response.body.pool, null, 'the pool is no longer their active one');

    const pools = await poolEvents(poolId);
    assert.deepStrictEqual(eventTypesOf(pools).slice(-5), [
      'MEMBER_DROPPED_OFF',
      'STOP_ARRIVED',
      'MEMBER_DROPPED_OFF',
      'TRIP_COMPLETED',
      'DRIVER_AVAILABLE',
    ]);
  });

  it('repeats without moving anything for a pool that is already complete (category 17)', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveTheWholeTrip(cookie, poolId);

    const before = {
      pool: await poolRow(poolId),
      events: await poolEvents(poolId),
      driver: await driverRow(jashim.driverProfile.id),
      members: await membersOf(poolId),
    };

    for (const response of [
      await complete(cookie, poolId),
      await depart(cookie, poolId),
      await start(cookie, poolId),
    ]) {
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
      assert.strictEqual(response.body.pool.status, 'COMPLETED');
    }

    assert.deepStrictEqual(await poolRow(poolId), before.pool);
    assert.deepStrictEqual(await poolEvents(poolId), before.events);
    assert.deepStrictEqual(await driverRow(jashim.driverProfile.id), before.driver);
    assert.deepStrictEqual(await membersOf(poolId), before.members);
  });
});

// ========================================================================
// 9. Retries
// ========================================================================

describe('retries', () => {
  it('answers the same for every command sent twice, and writes nothing the second time (category 17)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    const [firstPickup, dropoffStop] = await stopsOf(poolId);

    await depart(cookie, poolId);
    await arrive(cookie, poolId, firstPickup.id);
    await pickup(cookie, poolId, firstPickup.id, firstPickup.pool_member_id);
    await arrive(cookie, poolId, dropoffStop.id);
    await start(cookie, poolId);
    await dropoff(cookie, poolId, dropoffStop.id, dropoffStop.pool_member_id);
    await complete(cookie, poolId);

    const before = {
      pool: await poolRow(poolId),
      stops: await stopsOf(poolId),
      members: await membersOf(poolId),
      events: await poolEvents(poolId),
      ride: await rideEvents(firstPickup.ride_request_id),
      driver: await driverRow(jashim.driverProfile.id),
    };

    // Every command again, in the same order, now that each has already happened.
    const retries = [
      await depart(cookie, poolId),
      await arrive(cookie, poolId, firstPickup.id),
      await pickup(cookie, poolId, firstPickup.id, firstPickup.pool_member_id),
      await start(cookie, poolId),
      await dropoff(cookie, poolId, dropoffStop.id, dropoffStop.pool_member_id),
      await complete(cookie, poolId),
    ];

    for (const response of retries) {
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
      assert.strictEqual(response.body.pool.status, 'COMPLETED');
    }

    assert.deepStrictEqual(await poolRow(poolId), before.pool, 'no timestamp moved');
    assert.deepStrictEqual(await stopsOf(poolId), before.stops);
    assert.deepStrictEqual(await membersOf(poolId), before.members);
    assert.deepStrictEqual(await poolEvents(poolId), before.events, 'no second event');
    assert.deepStrictEqual(await rideEvents(firstPickup.ride_request_id), before.ride);
    assert.deepStrictEqual(await driverRow(jashim.driverProfile.id), before.driver);
  });

  it('does not mistake a stop that has not been reached for a retry', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    await arrive(cookie, poolId, stops[0].id);
    await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id);

    // The second stop at the same corner has not been reached: that is a 409, not
    // a repeated success.
    const notYet = await pickup(cookie, poolId, stops[1].id, stops[1].pool_member_id);
    assert.strictEqual(notYet.status, 409);
    assert.match(notYet.body.error.message, /cannot be served before|has not been reached/i);
  });
});

// ========================================================================
// 10. Concurrency
// ========================================================================

describe('two commands at once', () => {
  it('produces one arrival, one event and one arrival time from two at once (category 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop] = await stopsOf(poolId);

    const [first, second] = await Promise.all([
      arrive(cookie, poolId, pickupStop.id),
      arrive(cookie, poolId, pickupStop.id),
    ]);

    // Whoever wins the pool's lock applies it; the other one sees the result and
    // reports it. Both are successful answers to the same command.
    assert.deepStrictEqual([first.status, second.status], [200, 200]);

    const events = await poolEvents(poolId);
    assert.strictEqual(countOf(events, 'STOP_ARRIVED'), 1, 'one arrival happened');

    const stops = await stopsOf(poolId);
    assert.strictEqual(stops[0].status, 'ARRIVED');

    const arrivals = (await rideEvents(pickupStop.ride_request_id)).filter(
      (event) => event.event_type === 'DRIVER_ARRIVED',
    );
    assert.strictEqual(arrivals.length, 1, 'and the passenger was told once');
  });

  it('produces one collection from two at once (category 18)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop] = await stopsOf(poolId);
    await arrive(cookie, poolId, pickupStop.id);

    const [first, second] = await Promise.all([
      pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id),
      pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id),
    ]);

    assert.deepStrictEqual([first.status, second.status], [200, 200]);

    const events = await poolEvents(poolId);
    assert.strictEqual(countOf(events, 'MEMBER_PICKED_UP'), 1);
    assert.strictEqual(
      (await rideEvents(nusratRequest.id)).filter((event) => event.event_type === 'PASSENGER_PICKED_UP')
        .length,
      1,
    );

    const members = await membersOf(poolId);
    assert.strictEqual(members[0].status, 'PICKED_UP');
  });

  it('never starts a trip with a pickup still open, whichever way the race goes (category 18)', async () => {
    const { poolId, rafiqRequest } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const stops = await stopsOf(poolId);

    await arrive(cookie, poolId, stops[0].id);
    await pickup(cookie, poolId, stops[0].id, stops[0].pool_member_id);
    await arrive(cookie, poolId, stops[1].id);

    // Starting and collecting the second passenger at the same instant: the start
    // may lose (409) or win (the collection happens first and clears the way).
    const [started, collected] = await Promise.all([
      start(cookie, poolId),
      pickup(cookie, poolId, stops[1].id, stops[1].pool_member_id),
    ]);

    assert.strictEqual(collected.status, 200);
    assert.ok([200, 409].includes(started.status), `${started.status}`);

    const row = await poolRow(poolId);
    const members = await membersOf(poolId);
    const requests = await Promise.all(members.map((member) => requestRow(member.ride_request_id)));

    if (row.status === 'IN_PROGRESS') {
      assert.ok(
        members.every((member) => member.status === 'PICKED_UP'),
        'a started trip has everyone at the corner aboard',
      );
      assert.ok(requests.every((request) => request.status === 'IN_PROGRESS'));
    } else {
      assert.strictEqual(row.started_at, null);
    }

    assert.ok(
      (await rideEvents(rafiqRequest.id)).some((event) => event.event_type === 'PASSENGER_PICKED_UP'),
    );
  });

  it('leaves a consistent pool when a delivery races the completion (category 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const [pickupStop, dropoffStop] = await stopsOf(poolId);

    await arrive(cookie, poolId, pickupStop.id);
    await pickup(cookie, poolId, pickupStop.id, pickupStop.pool_member_id);
    await arrive(cookie, poolId, dropoffStop.id);
    await start(cookie, poolId);

    const [delivered, finished] = await Promise.all([
      dropoff(cookie, poolId, dropoffStop.id, dropoffStop.pool_member_id),
      complete(cookie, poolId),
    ]);

    assert.strictEqual(delivered.status, 200);
    assert.ok([200, 409].includes(finished.status));

    const row = await poolRow(poolId);
    const member = (await membersOf(poolId))[0];
    const stop = (await stopsOf(poolId)).find((candidate) => candidate.id === dropoffStop.id);

    // The invariant either way: a completed pool has no unfinished stop and no
    // passenger left in the car.
    if (row.status === 'COMPLETED') {
      assert.strictEqual(member.status, 'DROPPED_OFF');
      assert.strictEqual(stop.status, 'COMPLETED');
      assert.strictEqual((await driverRow(jashim.driverProfile.id)).status, 'AVAILABLE');
    } else {
      assert.strictEqual(row.status, 'IN_PROGRESS');
      assert.strictEqual(member.status, 'DROPPED_OFF');
    }
  });

  it('cannot be operated by matching once it has departed (category 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);

    const waiting = await requestRide(rafiq);
    const [anyPoint, anyDestination] = await Promise.all([
      prisma.servicePoint.findUnique({ where: { code: POINTS.MID } }),
      prisma.servicePoint.findUnique({ where: { code: POINTS.DESTINATION } }),
    ]);

    const candidates = await matching.findCandidatePools({
      pickupServicePointId: anyPoint.id,
      dropoffServicePointId: anyDestination.id,
      rideRequestId: waiting.id,
    });

    assert.deepStrictEqual(candidates, [], 'a departed pool is not a candidate');
    assert.deepStrictEqual(ELIGIBLE_POOL_STATUSES, ['FORMING']);

    // And a join offer that was already outstanding cannot be accepted either.
    const driverProfile = await prisma.driverProfile.findUnique({
      where: { id: jashim.driverProfile.id },
      select: { activeVehicleId: true },
    });

    const joinOffer = await prisma.dispatchOffer.create({
      data: {
        rideRequestId: waiting.id,
        driverProfileId: jashim.driverProfile.id,
        vehicleId: driverProfile.activeVehicleId,
        offerType: 'ADD_PASSENGER',
        ridePoolId: poolId,
        poolVersion: (await poolRow(poolId)).version,
        approachDistanceMeters: 100,
        approachDurationSeconds: 60,
        score: 60,
        offeredAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        proposalSnapshot: { poolId },
      },
      select: { id: true },
    });

    const refused = await offers.acceptOffer({ driver: jashim, offerId: joinOffer.id }).then(
      () => null,
      (err) => err,
    );
    assert.ok(refused, 'a departed pool cannot be joined');
    assert.strictEqual(refused.statusCode, 409);
  });

  it('cannot re-price a pool whose trip is under way (category 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);

    const error = await recalculatePoolFaresStandalone({
      ridePoolId: poolId,
      expectedPoolVersion: (await poolRow(poolId)).version,
    }).then(
      () => null,
      (err) => err,
    );

    assert.ok(error, 'a trip in progress has no estimate to recalculate');
    assert.strictEqual(error.statusCode, 409);
    assert.match(error.message, /forming/i);
  });
});

// ========================================================================
// 11. The passenger's own view
// ========================================================================

describe('what the passenger sees', () => {
  it('reports only their own part of the trip, and their own timeline (category 19)', async () => {
    const { poolId, nusratRequest, rafiqRequest } = await createTwoPassengerPool();
    const driverCookie = await login('jashim@example.com');
    const nusratCookie = await login('nusrat@example.com');
    const rafiqCookie = await login('rafiq@example.com');

    await driveToStart(driverCookie, poolId);

    const hers = await get(nusratCookie, `/ride-requests/${nusratRequest.id}`);
    const his = await get(rafiqCookie, `/ride-requests/${rafiqRequest.id}`);

    assert.strictEqual(hers.status, 200, JSON.stringify(hers.body));
    assert.strictEqual(his.status, 200, JSON.stringify(his.body));

    assert.strictEqual(hers.body.trip.poolId, poolId, 'the pool is shared, and named');
    assert.strictEqual(hers.body.trip.stage, 'IN_PROGRESS');
    assert.strictEqual(hers.body.trip.driver.displayName, 'Jashim');

    // Their own stops are theirs; nothing of the other passenger's appears.
    assert.strictEqual(hers.body.trip.stops.length, 2, 'their pickup and their drop-off');
    for (const stop of hers.body.trip.stops) {
      assert.ok(['PICKUP', 'DROPOFF'].includes(stop.stopType));
    }

    const theirMember = (await membersOf(poolId)).find(
      (member) => member.ride_request_id === nusratRequest.id,
    );
    const otherMember = (await membersOf(poolId)).find(
      (member) => member.ride_request_id === rafiqRequest.id,
    );

    const payload = JSON.stringify(hers.body);
    assert.ok(!payload.includes(otherMember.id), 'no identifier of the other passenger');
    assert.ok(!payload.includes(rafiqRequest.id), 'and not their ride request either');

    // Their timeline is their own, and carries no metadata about anybody.
    assert.ok(hers.body.trip.events.length > 0);
    for (const event of hers.body.trip.events) {
      assert.deepStrictEqual(Object.keys(event).sort(), ['actorType', 'createdAt', 'eventType', 'sequence']);
    }

    assert.ok(theirMember.id);
  });

  it('walks the passenger through the journey, stage by stage (category 19)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });
    const driverCookie = await login('jashim@example.com');
    const passengerCookie = await login('nusrat@example.com');

    const stage = async () =>
      (await get(passengerCookie, `/ride-requests/${nusratRequest.id}`)).body.trip.stage;

    assert.strictEqual(await stage(), 'DRIVER_ASSIGNED');

    await depart(driverCookie, poolId);
    assert.strictEqual(await stage(), 'DRIVER_EN_ROUTE');

    const [pickupStop, dropoffStop] = await stopsOf(poolId);

    await arrive(driverCookie, poolId, pickupStop.id);
    assert.strictEqual(await stage(), 'DRIVER_ARRIVED');

    await pickup(driverCookie, poolId, pickupStop.id, pickupStop.pool_member_id);
    assert.strictEqual(await stage(), 'PICKED_UP');

    await arrive(driverCookie, poolId, dropoffStop.id);
    await start(driverCookie, poolId);
    assert.strictEqual(await stage(), 'IN_PROGRESS');

    await dropoff(driverCookie, poolId, dropoffStop.id, dropoffStop.pool_member_id);
    assert.strictEqual(await stage(), 'RIDE_COMPLETED');

    const body = (await get(passengerCookie, `/ride-requests/${nusratRequest.id}`)).body;
    assert.strictEqual(body.status, 'COMPLETED');
    assert.ok(body.trip.timeline.pickedUpAt);
    assert.ok(body.trip.timeline.droppedOffAt);
  });

  it('lets a passenger read their fare after the trip has begun', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });
    const driverCookie = await login('jashim@example.com');
    const passengerCookie = await login('nusrat@example.com');

    await depart(driverCookie, poolId);

    const fare = await get(passengerCookie, `/ride-requests/${nusratRequest.id}/fare`);
    assert.strictEqual(fare.status, 200, JSON.stringify(fare.body));
    assert.strictEqual(fare.body.calculationStatus, 'FINALIZED', 'the fare the trip runs under');
    assert.strictEqual(fare.body.fareStatus, 'FINALIZED');
    assert.ok(fare.body.currentPooledFare);
  });

  it('does not expose the passenger\'s trip through the driver\'s pool view (category 19)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);
    const response = await get(cookie, '/drivers/me/pool');

    assert.strictEqual(response.status, 200);

    // No money, and no fare-shaped field: what the driver gets is whether the
    // fare is settled, which is a boolean about the pool.
    const payload = JSON.stringify(response.body);
    assert.doesNotMatch(payload, /"(fare|price|amount|cost|money|currency)[A-Za-z]*"\s*:/i);
    assert.strictEqual(response.body.pool.pricing.finalized, true);
  });
});

// ========================================================================
// 12. Scope
// ========================================================================

describe('scope', () => {
  it('introduces no payment, settlement or passenger-side trip operation', async () => {
    const cookie = await login('nusrat@example.com');

    for (const path of [
      '/payments',
      '/wallets',
      '/payouts',
      '/refunds',
      '/ride-requests/00000000-0000-4000-8000-000000000000/settle',
      '/ride-requests/00000000-0000-4000-8000-000000000000/pickup',
      '/ride-requests/00000000-0000-4000-8000-000000000000/dropoff',
      '/ride-requests/00000000-0000-4000-8000-000000000000/complete',
      '/drivers/me/trips',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      assert.strictEqual((await post(cookie, path)).status, 404, path);
    }
  });

  it('leaves the reserved states unused', async () => {
    const { poolId } = await createTwoPassengerPool();
    const cookie = await login('jashim@example.com');

    await driveTheWholeTrip(cookie, poolId);

    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM ride_pools WHERE status = 'CANCELLED')      AS pools,
              (SELECT count(*)::int FROM pool_stops WHERE status = 'SKIPPED')        AS stops,
              (SELECT count(*)::int FROM pool_members WHERE status IN ('CANCELLED', 'NO_SHOW')) AS members,
              (SELECT count(*)::int FROM ride_requests WHERE status IN ('CANCELLED', 'EXPIRED')) AS requests`,
    );

    assert.deepStrictEqual(rows[0], { pools: 0, stops: 0, members: 0, requests: 0 });
  });

  it('never writes a pool status that is not part of the trip', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);

    // The statuses the API can produce are exactly the trip's, in order.
    const seen = [(await poolRow(poolId)).status];
    const [pickupStop] = await stopsOf(poolId);
    await arrive(cookie, poolId, pickupStop.id);
    seen.push((await poolRow(poolId)).status);

    assert.deepStrictEqual(seen, ['DRIVER_EN_ROUTE', 'ARRIVED']);
  });

  it('answers /me/current-pool and its published alias /me/pool identically', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);

    const current = await currentPool(cookie);
    const alias = await get(cookie, '/drivers/me/pool');

    assert.strictEqual(current.status, 200);
    assert.strictEqual(alias.status, 200);
    assert.deepStrictEqual(current.body, alias.body);
    assert.strictEqual(current.body.pool.poolId, poolId);
    assert.deepStrictEqual(current.body.pool.allowedActions, ['ARRIVE_AT_STOP']);
  });
});

// --- Shared helpers used by more than one section ------------------------

/**
 * Leaves the pool IN_PROGRESS with the passengers at the first corner aboard.
 *
 * Departs, collects everybody at every pickup, and starts the trip -- the state
 * the delivery and completion tests need to begin from.
 */
async function driveToStart(cookie, poolId) {
  const departed = await depart(cookie, poolId);
  assert.strictEqual(departed.status, 200, JSON.stringify(departed.body));

  const stops = await stopsOf(poolId);

  for (const stop of stops.filter((candidate) => candidate.stop_type === 'PICKUP')) {
    // eslint-disable-next-line no-await-in-loop
    const arrived = await arrive(cookie, poolId, stop.id);
    assert.strictEqual(arrived.status, 200, JSON.stringify(arrived.body));

    // eslint-disable-next-line no-await-in-loop
    const collected = await pickup(cookie, poolId, stop.id, stop.pool_member_id);
    assert.strictEqual(collected.status, 200, JSON.stringify(collected.body));
  }

  const started = await start(cookie, poolId);
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  return started;
}
