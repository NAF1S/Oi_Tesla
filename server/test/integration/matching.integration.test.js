import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import * as assignment from '../../src/services/assignment.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as matching from '../../src/services/matching.service.js';
import {
  ELIGIBLE_POOL_STATUSES,
  MATCHING_RULE_VERSION,
  PLAN_REJECTION,
  simulateOccupancy,
} from '../../src/services/matching.rules.js';
import { SHARED_FARE_RULE_VERSION } from '../../src/services/pool-fare.rules.js';
import * as offers from '../../src/services/offer.service.js';
import { listPoolEvents } from '../../src/services/pool.service.js';
import {
  cancelRideRequest,
  createRideRequest,
  listRideEvents,
} from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase, sqlStateOf } from '../helpers/db.js';
import {
  createTestDriver,
  goOnline,
  loadDemoUser,
  POINTS,
  removeTestDriver,
  resetDispatchState,
  servicePointId,
  withEnv,
} from '../helpers/drivers.js';

/**
 * Pool-first matching: an existing pool before a driver of your own.
 *
 * The suite is organised the way the brief states the problem, because the
 * categories are the specification:
 *
 *   1. candidate pools   -- which pools are even considered, and the PostGIS prefilter
 *   2. stop insertion    -- every legal plan, measured and ranked
 *   3. capacity          -- the vehicle, segment by segment
 *   4. detour and wait   -- the limits, by name
 *   5. offers            -- one ADD_PASSENGER offer, and what a driver may do with it
 *   6. acceptance        -- the transaction that adds a passenger
 *   7. concurrency       -- what two writers cannot both do
 *   8. the demo scenario -- the walk-through, end to end
 *   9. scope             -- what this milestone deliberately did not add
 *
 * Most tests work through the services, because what matters is *which pool wins
 * and why*, and a candidate list is not something an HTTP client ever sees. The
 * driver's side is tested over HTTP, because that is where authorization and the
 * offer DTO are decided -- and where a client might try to submit a plan.
 */

/**
 * The instant a fixture prices and plans at.
 *
 * It is "now", not a pinned noon, and that is the point: a passenger's detour is
 * measured against the duration their own quote froze, so a quote priced in one
 * traffic regime and a plan measured in another make every join look like a
 * detour. Pinning noon made the suite pass in the off-peak window and fail inside
 * the rush (16:30-20:00 Dhaka) for a reason that had nothing to do with the rules
 * being tested. A test that needs a specific instant passes `now` explicitly.
 */
const planNow = () => new Date();

let api;
let nusrat;
let rafiq;
let shirin;
let tahmid;
let jashim;
let salauddin;
let karim;
let points;
let sequence = 0;

const nextKey = (label = 'matching') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

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

const asDriver = (cookie, path, options = {}) =>
  api.request(path, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

// --- Fixtures -----------------------------------------------------------

/** A real quote and a real WAITING request, without triggering assignment. */
const requestRide = async (
  passenger,
  { origin = POINTS.PICKUP, destination = POINTS.DESTINATION, now } = {},
) => {
  const { quote } = await createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: origin,
    destinationServicePointCode: destination,
    departureAt: now ?? planNow(),
  });

  const { request } = await createRideRequest({
    passenger,
    fareQuoteId: quote.id,
    idempotencyKey: nextKey(),
    ...(now ? { now } : {}),
  });

  return request;
};

/**
 * A committed pool with one passenger, created the way the product creates one:
 * an initial offer, accepted by its driver. Nothing here writes pool rows by
 * hand, so a fixture can never be in a state the product could not reach.
 */
const createInitialPool = async ({
  driver,
  passenger,
  origin = POINTS.PICKUP,
  destination = POINTS.DESTINATION,
  // The driver stands where the passenger is, which is what "online on the
  // starting point" means under the redesigned rule. A pool whose driver is
  // anywhere else can never take a second passenger, so this default is what
  // makes a fixture pool joinable at all.
  point = origin,
}) => {
  await goOnline(driver, point);

  const request = await requestRide(passenger, { origin, destination });
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });
  assert.strictEqual(accepted.joined, false, 'the fixture pool starts from an initial ride');

  return { request, poolId: accepted.pool.id, offerId: dispatched.offerId };
};

/** The request as the orchestrator loads it. */
const requestForAssignment = (rideRequestId) =>
  prisma.rideRequest.findUnique({
    where: { id: rideRequestId },
    select: {
      id: true,
      requestedAt: true,
      searchExpiresAt: true,
      pickupServicePointId: true,
      dropoffServicePointId: true,
      acceptedDistanceMeters: true,
      acceptedDurationSeconds: true,
    },
  });

const candidatesFor = async (rideRequestId, options = {}) => {
  const request = await requestForAssignment(rideRequestId);
  return matching.findCandidatePools({
    pickupServicePointId: request.pickupServicePointId,
    dropoffServicePointId: request.dropoffServicePointId,
    rideRequestId,
    ...options,
  });
};

const bestPlanFor = async (rideRequestId, now = new Date()) => {
  const request = await requestForAssignment(rideRequestId);
  return matching.findBestJoinPlan({ request, now });
};

// --- Reads --------------------------------------------------------------

const poolState = async (poolId) => {
  const { rows } = await pool.query(
    `SELECT rp.id, rp.status, rp.version, rp.capacity_snapshot,
            rp.planned_distance_meters::text  AS planned_distance_meters,
            rp.planned_duration_seconds       AS planned_duration_seconds,
            ST_AsText(rp.planned_route_geometry) AS geometry,
            ST_NPoints(rp.planned_route_geometry)::int AS geometry_points,
            (SELECT count(*)::int FROM pool_members pm WHERE pm.ride_pool_id = rp.id) AS members,
            (SELECT count(*)::int FROM pool_stops ps WHERE ps.ride_pool_id = rp.id)   AS stops
       FROM ride_pools rp WHERE rp.id = $1::uuid`,
    [poolId],
  );
  return rows[0];
};

const stopsOf = (poolId) =>
  pool
    .query(
      `SELECT ps.id, ps.sequence, ps.stop_type, ps.status, ps.ride_request_id, ps.pool_member_id,
              sp.code AS service_point_code, ps.planned_arrival_at
         FROM pool_stops ps
         JOIN service_points sp ON sp.id = ps.service_point_id
        WHERE ps.ride_pool_id = $1::uuid
        ORDER BY ps.sequence`,
      [poolId],
    )
    .then((result) => result.rows);

const offerRow = (offerId) =>
  pool
    .query(
      `SELECT id, offer_type, status, ride_pool_id, pool_version, driver_profile_id, vehicle_id,
              approach_distance_meters::text AS approach_distance_meters,
              approach_duration_seconds, score::text AS score, proposal_snapshot,
              offered_at, expires_at, responded_at
         FROM dispatch_offers WHERE id = $1::uuid`,
      [offerId],
    )
    .then((result) => result.rows[0]);

const offersFor = (rideRequestId) =>
  pool
    .query(
      `SELECT id, offer_type, status, driver_profile_id, ride_pool_id, pool_version, rejection_reason
         FROM dispatch_offers WHERE ride_request_id = $1::uuid ORDER BY offered_at`,
      [rideRequestId],
    )
    .then((result) => result.rows);

const requestStatus = async (rideRequestId) => {
  const { rows } = await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [
    rideRequestId,
  ]);
  return rows[0]?.status ?? null;
};

const driverStatus = async (driverProfileId) => {
  const { rows } = await pool.query(`SELECT status FROM driver_profiles WHERE id = $1::uuid`, [
    driverProfileId,
  ]);
  return rows[0]?.status ?? null;
};

const moneyAndFares = async () => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM fare_quotes) AS quotes,
            (SELECT coalesce(sum(accepted_fare), 0)::text FROM ride_requests) AS accepted_fares`,
  );
  return rows[0];
};

const poolEventTypes = (poolId) => listPoolEvents(poolId).then((events) => events.map((e) => e.eventType));
const rideEventTypes = (rideRequestId) =>
  listRideEvents(rideRequestId).then((events) => events.map((e) => e.eventType));

const memberIds = (poolId) =>
  pool
    .query(`SELECT id, ride_request_id, status FROM pool_members WHERE ride_pool_id = $1::uuid`, [
      poolId,
    ])
    .then((result) => result.rows);

const counts = async () => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM ride_pools)     AS pools,
            (SELECT count(*)::int FROM pool_members)   AS members,
            (SELECT count(*)::int FROM pool_stops)     AS stops,
            (SELECT count(*)::int FROM dispatch_offers) AS offers`,
  );
  return rows[0];
};

/** Moves a driver without touching their status: dispatch does not allow it while reserved. */
const moveDriverTo = (driverProfileId, code) =>
  pool.query(
    `UPDATE driver_profiles SET current_service_point_id = (SELECT id FROM service_points WHERE code = $2)
      WHERE id = $1::uuid`,
    [driverProfileId, code],
  );

const createTestPassenger = async (email, name = 'Test Passenger') => {
  // A previous run that failed before its own cleanup leaves the address behind,
  // so this is delete-then-create rather than create-or-fail.
  await prisma.user.deleteMany({ where: { email } });
  await prisma.user.create({
    data: {
      name,
      email,
      role: 'PASSENGER',
      active: true,
      passengerProfile: { create: {} },
    },
  });

  return prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, role: true, passengerProfile: { select: { id: true } } },
  });
};

// --- Lifecycle ----------------------------------------------------------

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');
  jashim = await loadDemoUser('jashim@example.com');

  salauddin = await createTestDriver({
    name: 'Salauddin',
    vehicleName: 'Second Car',
    password: env.demoSeedPassword,
  });
  karim = await createTestDriver({
    name: 'Karim',
    vehicleName: 'Third Car',
    password: env.demoSeedPassword,
  });
  tahmid = await createTestPassenger('tahmid@example.com');

  points = {
    pickup: await servicePointId(POINTS.PICKUP),
    destination: await servicePointId(POINTS.DESTINATION),
    near: await servicePointId(POINTS.NEAR),
    mid: await servicePointId(POINTS.MID),
    far: await servicePointId(POINTS.FAR),
    sank: await servicePointId('niketon-gate'),
  };

  // Same reason as the pool suite: a driver with two active vehicles cannot go
  // online at all, so debris from an interrupted run would break every test in
  // this file in a way that looks like a bug in the code under test.
  await resetDispatchState();
  await pool.query(`DELETE FROM vehicles WHERE name NOT IN ('Bullet', 'Second Car', 'Third Car')`);
});

beforeEach(async () => {
  // Pools, offers, rides and availability are all shared state: a driver left
  // RESERVED by one test is a candidate for the next one's ride.
  await resetDispatchState();

  jashim = await loadDemoUser('jashim@example.com');
  salauddin = await loadDemoUser(salauddin.email);
  karim = await loadDemoUser(karim.email);
});

after(async () => {
  await resetDispatchState();
  await removeTestDriver(salauddin.email);
  await removeTestDriver(karim.email);
  await prisma.user.deleteMany({ where: { email: 'tahmid@example.com' } });
  await prisma.user.deleteMany({ where: { email: 'latecomer@example.com' } });
  await api.close();
  await closePool();
});

// ========================================================================
// 1. Candidate pools
// ========================================================================

describe('candidate pools', () => {
  it('considers a forming pool on the same corridor, and nothing else (category 1)', async () => {
    const { request: nusratRequest, poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });

    const rafiqRequest = await requestRide(rafiq);
    const candidates = await candidatesFor(rafiqRequest.id);

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].id, poolId);
    assert.strictEqual(candidates[0].status, 'FORMING');
    assert.strictEqual(candidates[0].member_count, 1);
    assert.strictEqual(candidates[0].capacity_snapshot, 3);
    assert.ok(
      candidates[0].pickup_distance_meters < env.matching.radiusMeters,
      'the candidate is inside the configured radius',
    );
    assert.notStrictEqual(nusratRequest.id, rafiqRequest.id);
  });

  it('stops considering a pool the moment it is no longer forming (category 1)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    // Every status a pool can hold that is not FORMING. The lifecycle check
    // requires a timestamp for the terminal ones, so they come with one.
    const ineligible = [
      ['DRIVER_EN_ROUTE', null],
      ['ARRIVED', null],
      ['IN_PROGRESS', 'started_at'],
      ['COMPLETED', 'completed_at'],
      ['CANCELLED', 'cancelled_at'],
    ];

    for (const [status, timestampColumn] of ineligible) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE ride_pools
            SET status = 'FORMING', departed_at = NULL, driver_arrived_at = NULL,
                started_at = NULL, completed_at = NULL, cancelled_at = NULL
          WHERE id = $1::uuid`,
        [poolId],
      );
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE ride_pools
            SET status = $2::ride_pool_status,
                departed_at = now(),
                driver_arrived_at = CASE WHEN $2 = 'ARRIVED' THEN now() ELSE NULL END
                ${timestampColumn ? `, ${timestampColumn} = now()` : ''}
          WHERE id = $1::uuid`,
        [poolId, status],
      );

      // eslint-disable-next-line no-await-in-loop
      const candidates = await candidatesFor(rafiqRequest.id);
      assert.strictEqual(candidates.length, 0, `a ${status} pool must not be a candidate`);
    }
  });

  // Removed in the v2 redesign: the pool's stored route geometry is no longer a
  // filter. A pool is eligible because of who is in it and where it starts, not
  // because a line on a map is still readable.

  it('excludes a pool with no free seat (category 2)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    // One member, one seat: nothing to offer.
    await pool.query(`UPDATE ride_pools SET capacity_snapshot = 1 WHERE id = $1::uuid`, [poolId]);

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 0);

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.strictEqual(outcome.assigned, false, 'no second driver is available');
    assert.deepStrictEqual(
      (await offersFor(rafiqRequest.id)).filter((offer) => offer.offer_type === 'ADD_PASSENGER'),
      [],
      'a full pool must never produce a join offer',
    );
  });

  it('excludes a pool whose stops are no longer pending (category 1)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    await pool.query(
      `UPDATE pool_stops SET status = 'ARRIVED', actual_arrival_at = now()
        WHERE ride_pool_id = $1::uuid AND sequence = 1`,
      [poolId],
    );

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 0);
  });

  it('excludes a pool whose driver or vehicle is no longer in service (category 1)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const driverProfileId = jashim.driverProfile.id;
    const vehicleId = jashim.driverProfile.vehicles[0].id;

    const cases = [
      [
        'the driver is no longer committed to the pool',
        [`UPDATE driver_profiles SET status = 'OFFLINE' WHERE id = $1::uuid`, [driverProfileId]],
        [`UPDATE driver_profiles SET status = 'RESERVED' WHERE id = $1::uuid`, [driverProfileId]],
      ],
      [
        'the driver has no current point',
        [`UPDATE driver_profiles SET current_service_point_id = NULL WHERE id = $1::uuid`, [driverProfileId]],
        [`UPDATE driver_profiles SET current_service_point_id = $2::uuid WHERE id = $1::uuid`, [driverProfileId, points.pickup]],
      ],
      [
        'the vehicle was taken out of service',
        [`UPDATE vehicles SET active = false WHERE id = $1::uuid`, [vehicleId]],
        [`UPDATE vehicles SET active = true WHERE id = $1::uuid`, [vehicleId]],
      ],
      [
        "the driver's account was suspended",
        [`UPDATE users SET active = false WHERE id = $1::uuid`, [jashim.id]],
        [`UPDATE users SET active = true WHERE id = $1::uuid`, [jashim.id]],
      ],
    ];

    for (const [description, [breakIt, breakParams], [fixIt, fixParams]] of cases) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(breakIt, breakParams);
      // eslint-disable-next-line no-await-in-loop
      assert.strictEqual(
        (await candidatesFor(rafiqRequest.id)).length,
        0,
        `a pool must not be offered when ${description}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await pool.query(fixIt, fixParams);
    }

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 1, 'and back again');
    assert.strictEqual((await poolState(poolId)).members, 1);
  });

  it('excludes a pool that already has a route change pending (category 26)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const rafiqRequest = await requestRide(rafiq);
    const first = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(first.mode, 'POOL_JOIN');

    // One pool may have at most one pending route-change offer, so a second
    // passenger cannot be offered a seat that is already being negotiated.
    const shirinRequest = await requestRide(shirin);
    assert.strictEqual((await candidatesFor(shirinRequest.id)).length, 0);

    const second = await assignment.assignWaitingRequest({ rideRequestId: shirinRequest.id });
    assert.strictEqual(second.mode, 'INITIAL_RIDE');
    assert.strictEqual(
      (await offersFor(shirinRequest.id)).length,
      0,
      'no offer at all while the pool is negotiating with somebody else',
    );
    assert.strictEqual((await poolState(poolId)).version, 1);
  });

  it('excludes a driver who has already refused this request (category 5)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');

    await offers.rejectOffer({ driver: jashim, offerId: offered.offerId, reason: 'TOO_FAR' });

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 0);
    assert.strictEqual((await poolState(poolId)).members, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
  });

  // Removed in the v2 redesign: proximity shortlisting, the two radii and the
  // "a nearby pool may cost nothing" controls. None of them describe eligibility
  // any more -- two rides share a car because they start from the same service
  // point and their destinations can reach each other, not because a radius was
  // generous. The same-start half is asserted in the demo scenario, and the
  // reachability half in the unroutable case below.

  it('rejects a stop sequence the router cannot connect (category 11)', async () => {
    const { poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      origin: 'banani-road-11',
      destination: 'niketon-gate',
    });
    const rafiqRequest = await requestRide(rafiq, {
      origin: 'banani-road-11',
      destination: 'khamarbari',
    });

    // Both start from Banani Road 11, so the pool is a legal candidate -- and what
    // refuses it is the road. Niketon Gate and Khamarbari are the seeded graph's
    // dead ends: neither can be left and neither can reach the other, so no stop
    // order can serve both. Reachability is the second half of the rule, and this
    // is that half firing.
    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 1, 'still a candidate');

    const search = await bestPlanFor(rafiqRequest.id);
    assert.strictEqual(search.plan, null);
    assert.ok(search.rejections[PLAN_REJECTION.UNROUTABLE] > 0, JSON.stringify(search.rejections));

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.strictEqual((await poolState(poolId)).members, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
  });
});

// ========================================================================
// 2. Stop insertion
// ========================================================================

describe('stop insertion', () => {
  it('evaluates every insertion pair and keeps the best one (categories 8, 9, 10)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const search = await bestPlanFor(rafiqRequest.id);

    // One member, two stops: six ordered pairs of positions, all routed.
    assert.strictEqual(search.evaluated, 6);
    assert.strictEqual(search.candidates.length, 1);

    const stops = search.plan.metrics.stops;
    const newPickup = stops.findIndex(
      (stop) => stop.isNew && stop.stopType === 'PICKUP',
    );
    const newDropoff = stops.findIndex(
      (stop) => stop.isNew && stop.stopType === 'DROPOFF',
    );

    assert.ok(newPickup < newDropoff, 'the pickup is always before the drop-off');
    assert.deepStrictEqual(
      stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      ['1:PICKUP', '2:PICKUP', '3:DROPOFF', '4:DROPOFF'],
    );

    // The existing passenger's own journey is untouched by the plan.
    assert.deepStrictEqual(
      stops.filter((stop) => !stop.isNew).map((stop) => stop.stopId),
      (await stopsOf(search.plan.poolId)).map((stop) => stop.id),
      'the existing stops keep their relative order and their identity',
    );
  });

  it('is deterministic: the same situation produces the same plan (category 25)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const now = new Date();
    const first = await bestPlanFor(rafiqRequest.id, now);
    const second = await bestPlanFor(rafiqRequest.id, now);

    assert.strictEqual(first.plan.metrics.stopOrderSignature, second.plan.metrics.stopOrderSignature);
    assert.strictEqual(first.plan.score, second.plan.score);
    assert.deepStrictEqual(
      first.candidates.map((candidate) => candidate.poolId),
      second.candidates.map((candidate) => candidate.poolId),
    );
  });

  it('prefers an older pool when two plans are equally good (category 25)', async () => {
    // Two identical pools for two passengers on the same corridor, created in a
    // known order: the tie-break is "lowest score, then the oldest pool", so the
    // first one must win.
    const first = await createInitialPool({ driver: jashim, passenger: nusrat });
    const second = await createInitialPool({ driver: salauddin, passenger: shirin });
    const rafiqRequest = await requestRide(rafiq);

    const search = await bestPlanFor(rafiqRequest.id);
    assert.strictEqual(search.candidates.length, 2);
    assert.strictEqual(search.plan.poolId, first.poolId);
    assert.notStrictEqual(search.plan.poolId, second.poolId);
  });

  it('plans arrivals in stop order, so a driver can be shown the whole change (category 13)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const now = new Date();
    const search = await bestPlanFor(rafiqRequest.id, now);
    const arrivals = search.plan.metrics.arrivals;

    assert.strictEqual(arrivals.length, 4);
    for (let index = 1; index < arrivals.length; index += 1) {
      assert.ok(
        arrivals[index].getTime() >= arrivals[index - 1].getTime(),
        `arrival ${index} is not before the one after it`,
      );
    }

    const firstStopEta = (arrivals[0].getTime() - now.getTime()) / 1000;
    assert.strictEqual(firstStopEta, search.plan.metrics.approach.durationSeconds);

    // Every arrival is exactly the planning instant plus the legs before it: one
    // clock, and the same clock acceptance re-anchors to.
    let elapsed = search.plan.metrics.approach.durationSeconds;
    search.plan.metrics.legs.forEach((leg, index) => {
      elapsed += leg.durationSeconds;
      assert.strictEqual((arrivals[index + 1].getTime() - now.getTime()) / 1000, elapsed);
    });
  });

  it('supports a pool that already has two passengers (category 14)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    // Rafiq joins first, the ordinary way.
    const rafiqRequest = await requestRide(rafiq);
    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');
    await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });

    assert.strictEqual((await stopsOf(poolId)).length, 4);

    // Now a third passenger: a three-member pool is four existing stops, so
    // fifteen insertion pairs -- which is the point, because a two-passenger
    // shortcut would still answer six.
    const tahmidRequest = await requestRide(tahmid);
    const search = await bestPlanFor(tahmidRequest.id);

    assert.strictEqual(search.evaluated, 15);
    assert.ok(search.plan, JSON.stringify(search.rejections));
    assert.strictEqual(search.plan.metrics.stops.length, 6);
    assert.strictEqual(search.plan.occupancy.valid, true);

    const result = await assignment.assignWaitingRequest({ rideRequestId: tahmidRequest.id });
    assert.strictEqual(result.mode, 'POOL_JOIN');

    await offers.acceptOffer({ driver: jashim, offerId: result.offerId });

    const state = await poolState(poolId);
    assert.strictEqual(state.members, 3);
    assert.strictEqual(state.stops, 6);
    assert.strictEqual(state.version, 3, 'one version per accepted plan change');
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => stop.sequence),
      [1, 2, 3, 4, 5, 6],
    );
  });
});

// ========================================================================
// 3. Capacity
// ========================================================================

describe('capacity', () => {
  it('refuses a plan that would put more passengers in the car than it holds (categories 15, 16)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    // One member in a one-seat pool: the pool is not even a candidate, which is
    // the first of the two defences. The seat count is checked before anything is
    // simulated, so a full car is never offered to anybody.
    await pool.query(`UPDATE ride_pools SET capacity_snapshot = 1 WHERE id = $1::uuid`, [poolId]);

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 0);

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.deepStrictEqual(
      (await offersFor(rafiqRequest.id)).filter((offer) => offer.offer_type === 'ADD_PASSENGER'),
      [],
      'a full pool must never produce a join offer',
    );

    // The second defence, for anything the shortlist cannot see: the simulation
    // refuses an order that seats two passengers in one seat.
    const twoAtOnce = simulateOccupancy({
      stops: [
        { memberKey: 'A', stopType: 'PICKUP', sequence: 1 },
        { memberKey: 'B', stopType: 'PICKUP', sequence: 2 },
        { memberKey: 'A', stopType: 'DROPOFF', sequence: 3 },
        { memberKey: 'B', stopType: 'DROPOFF', sequence: 4 },
      ],
      capacity: 1,
    });
    assert.strictEqual(twoAtOnce.valid, false);
    assert.strictEqual(twoAtOnce.detail, 'capacity_exceeded');

    // The same order is legal in a three-seat car.
    assert.strictEqual(
      simulateOccupancy({
        stops: [
          { memberKey: 'A', stopType: 'PICKUP', sequence: 1 },
          { memberKey: 'B', stopType: 'PICKUP', sequence: 2 },
          { memberKey: 'A', stopType: 'DROPOFF', sequence: 3 },
          { memberKey: 'B', stopType: 'DROPOFF', sequence: 4 },
        ],
        capacity: 3,
      }).valid,
      true,
    );
  });

  it('checks capacity on every segment, not by counting members (category 15)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const search = await bestPlanFor(rafiqRequest.id);
    const plan = search.plan;

    // The plan accounts for who is in the vehicle between every pair of stops,
    // and the peak is derived from that timeline -- not from "how many members
    // does this pool have".
    assert.strictEqual(plan.occupancy.valid, true);
    assert.strictEqual(plan.occupancy.timeline.length, plan.metrics.stops.length);
    assert.deepStrictEqual(
      plan.occupancy.timeline.map((entry) => entry.sequence),
      plan.metrics.stops.map((stop) => stop.sequence),
      'one entry per segment, in stop order',
    );
    assert.strictEqual(
      Math.max(...plan.occupancy.timeline.map((entry) => entry.occupancyAfter)),
      plan.occupancy.peakOccupancy,
    );
    assert.ok(
      plan.occupancy.timeline.every((entry) => entry.occupancyAfter <= 3),
      'never above the vehicle\'s capacity',
    );
    assert.strictEqual(plan.occupancy.timeline.at(-1).occupancyAfter, 0, 'and empty at the end');
  });

  it('offers a seat that a drop-off has released (categories 17, 18)', async () => {
    // Seat release is a property of the *plan*, not of who boards where: a vehicle
    // that sets somebody down before collecting the next passenger has that seat
    // free again. It used to be asserted by building a pool whose second passenger
    // started where the first one finished, but a shared start is now required, so
    // that pool is not eligible at all. The property itself is unchanged, so this
    // asserts it against the simulator that decides it.
    const released = simulateOccupancy({
      capacity: 1,
      stops: [
        { memberKey: 'a', stopType: 'PICKUP' },
        { memberKey: 'a', stopType: 'DROPOFF' },
        { memberKey: 'b', stopType: 'PICKUP' },
        { memberKey: 'b', stopType: 'DROPOFF' },
      ],
    });

    assert.strictEqual(released.valid, true, 'one seat is enough when it is released first');
    assert.deepStrictEqual(
      released.timeline.map((entry) => entry.occupancyAfter),
      [1, 0, 1, 0],
      'the seat is released before it is taken again',
    );
    assert.strictEqual(released.peakOccupancy, 1);

    // The other order is refused with the same one seat: the second passenger
    // cannot board while the first is still aboard.
    const refused = simulateOccupancy({
      capacity: 1,
      stops: [
        { memberKey: 'a', stopType: 'PICKUP' },
        { memberKey: 'b', stopType: 'PICKUP' },
        { memberKey: 'a', stopType: 'DROPOFF' },
        { memberKey: 'b', stopType: 'DROPOFF' },
      ],
    });

    assert.strictEqual(refused.valid, false);
    assert.strictEqual(refused.reason, PLAN_REJECTION.OCCUPANCY);
  });

  it('never leaves a join half-applied when the pool has moved on (categories 19, 20, 48)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    const before = await poolState(poolId);
    const stopsBefore = await stopsOf(poolId);

    // A stored plan cannot be edited after the fact: the offer row is immutable
    // by trigger, which is what lets acceptance re-anchor the plan it was given
    // instead of recomputing it. A driver client therefore cannot submit one, and
    // neither can anything else.
    await assert.rejects(
      () =>
        pool.query(`UPDATE dispatch_offers SET proposal_snapshot = $2::jsonb WHERE id = $1::uuid`, [
          offered.offerId,
          JSON.stringify({ stops: [] }),
        ]),
      (err) => sqlStateOf(err) === '23514' && /immutable/.test(err.message),
    );
    assert.deepStrictEqual((await offerRow(offered.offerId)).proposal_snapshot.stops.length, 4);

    // And what *is* mutable -- the pool -- is re-checked at acceptance. A stop was
    // collected after the offer was made, so the plan no longer describes the
    // pool, and the whole transaction is rolled back.
    await pool.query(
      `UPDATE pool_stops SET status = 'ARRIVED', actual_arrival_at = now()
        WHERE ride_pool_id = $1::uuid AND sequence = 1`,
      [poolId],
    );

    await assert.rejects(
      () => offers.acceptOffer({ driver: jashim, offerId: offered.offerId }),
      (err) => err.statusCode === 409 && /stop in progress/.test(err.message),
    );

    const after = await poolState(poolId);
    assert.deepStrictEqual(
      { version: after.version, members: after.members, stops: after.stops },
      { version: before.version, members: before.members, stops: before.stops },
      'nothing about the pool may change',
    );
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => stop.id),
      stopsBefore.map((stop) => stop.id),
      'not a single stop row was replaced',
    );
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => stop.sequence),
      [1, 2],
      'the resequencing offset leaves no residue',
    );
    assert.strictEqual((await memberIds(poolId)).length, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual(
      (await offerRow(offered.offerId)).status,
      'PENDING',
      'a refusal before any write leaves the offer answerable',
    );
  });
});

// ========================================================================
// 4. Detour and waiting rules
// ========================================================================

describe('waiting window', () => {
  // The detour and waiting-*limit* tests that used to open this block were removed
  // in the v2 redesign: a join is no longer refused for costing too much time.
  // What remains is the *window* -- how long a request is considered for somebody
  // else's pool at all -- which is a different rule and still applies.

  it('stops trying to use existing pools once the passenger has waited too long (category 21)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });

    // The request is older than the matching window, so the orchestrator does not
    // even look for a pool: a passenger who has already waited is not helped by
    // somebody else's detour.
    const rafiqRequest = await requestRide(rafiq, {
      now: new Date(Date.now() - (env.matching.windowSeconds + 60) * 1000),
    });

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 1, 'a pool was available');
    assert.deepStrictEqual(
      (await offersFor(rafiqRequest.id)).filter((offer) => offer.offer_type === 'ADD_PASSENGER'),
      [],
      'and was deliberately not used',
    );

    const events = await listRideEvents(rafiqRequest.id);
    assert.strictEqual(events.at(-1).eventType, 'INITIAL_DISPATCH_FALLBACK');
    assert.strictEqual(events.at(-1).metadata.reason, 'matching_window_closed');
    assert.strictEqual(events.at(-1).metadata.windowSeconds, env.matching.windowSeconds);
  });
});

// ========================================================================
// 5. Offers
// ========================================================================

describe('offers', () => {
  it('creates one ADD_PASSENGER offer for the best pool, and leaves the passenger waiting (category 26)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    assert.strictEqual(outcome.assigned, true);
    assert.strictEqual(outcome.mode, 'POOL_JOIN');
    assert.strictEqual(outcome.ridePoolId, poolId);
    assert.strictEqual(outcome.poolVersion, 1);
    assert.strictEqual(outcome.driverProfileId, jashim.driverProfile.id);
    assert.strictEqual(outcome.candidatePools, 1);
    assert.strictEqual(outcome.evaluatedPlans, 6);
    assert.ok(outcome.score > 0);

    const offer = await offerRow(outcome.offerId);
    assert.strictEqual(offer.offer_type, 'ADD_PASSENGER');
    assert.strictEqual(offer.status, 'PENDING');
    assert.strictEqual(offer.ride_pool_id, poolId);
    assert.strictEqual(offer.pool_version, 1, 'the version the plan was built from');
    assert.strictEqual(offer.driver_profile_id, jashim.driverProfile.id, 'the pool\'s own driver');
    assert.strictEqual(offer.vehicle_id, jashim.driverProfile.vehicles[0].id);

    // The snapshot is the plan, and it is the only source of it: a driver can
    // read it and cannot send one.
    assert.strictEqual(offer.proposal_snapshot.ruleVersion, MATCHING_RULE_VERSION);
    assert.strictEqual(offer.proposal_snapshot.poolId, poolId);
    assert.strictEqual(offer.proposal_snapshot.poolVersion, 1);
    assert.strictEqual(offer.proposal_snapshot.rideRequestId, rafiqRequest.id);
    assert.deepStrictEqual(
      offer.proposal_snapshot.stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      ['1:PICKUP', '2:PICKUP', '3:DROPOFF', '4:DROPOFF'],
    );
    assert.ok(
      Math.abs(offer.proposal_snapshot.score - Number(offer.score)) < 0.01,
      'the stored score is the plan\'s, rounded to the column',
    );
    assert.strictEqual(
      offer.approach_duration_seconds,
      offer.proposal_snapshot.approach.durationSeconds,
      'the approach is how the driver reaches the new passenger',
    );
    assert.ok(
      Math.abs(Number(offer.approach_distance_meters) - offer.proposal_snapshot.approach.distanceMeters) < 1,
      'the stored distance is the plan\'s, rounded to the column',
    );

    // Nothing has happened to the ride yet: offering is not assigning.
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual((await memberIds(poolId)).length, 1);
    const state = await poolState(poolId);
    assert.strictEqual(state.version, 1);
    assert.strictEqual(state.stops, 2);
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'RESERVED');

    assert.deepStrictEqual(await rideEventTypes(rafiqRequest.id), [
      'RIDE_REQUESTED',
      'POOL_CANDIDATE_EVALUATED',
      'POOL_JOIN_OFFERED',
    ]);

    const poolEvents = await poolEventTypes(poolId);
    assert.deepStrictEqual(poolEvents.at(-1), 'JOIN_PLAN_CREATED');
    assert.deepStrictEqual(poolEvents.slice(0, 3), [
      'POOL_CREATED',
      'MEMBER_ADDED',
      'ROUTE_PLAN_CREATED',
    ], 'the pool was created by the initial ride, and offering has not changed it');
  });

  it('does not offer twice when the orchestrator is called again (category 27)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const first = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    const before = await counts();

    const again = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(again.assigned, false);
    assert.strictEqual(again.reason, 'already_offered');
    assert.strictEqual(again.offerId, first.offerId);
    assert.strictEqual(again.offerType, 'ADD_PASSENGER');

    // And a third time, and a run of the sweeper, for good measure: a request
    // with an offer outstanding is not even examined.
    await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    const sweep = await dispatch.retryWaitingRequests();
    assert.strictEqual(sweep.examined, 0);
    assert.strictEqual(sweep.dispatched, 0);

    const after = await counts();
    assert.deepStrictEqual(after, before, 'no second offer of any kind');
    assert.strictEqual((await offersFor(rafiqRequest.id)).length, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');

    await dispatch.expireOverdueOffers();
    assert.strictEqual((await offersFor(rafiqRequest.id)).length, 1);
  });

  it('shows the offer to the pool\'s driver, and to nobody else (category 28)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    await goOnline(salauddin, POINTS.MID);

    const jashimCookie = await login('jashim@example.com');
    const salauddinCookie = await login(salauddin.email);
    const nusratCookie = await login('nusrat@example.com');

    const mine = await asDriver(jashimCookie, '/drivers/me/offers', { method: 'GET' });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.data.length, 1);
    assert.strictEqual(mine.body.data[0].offerType, 'ADD_PASSENGER');
    assert.strictEqual(mine.body.data[0].offerId, offerId);
    assert.strictEqual(mine.body.data[0].poolVersion, 1);
    assert.strictEqual(mine.body.data[0].capacity.seats, 3);
    assert.strictEqual(mine.body.data[0].capacity.peakOccupancy, 2);
    assert.deepStrictEqual(
      mine.body.data[0].proposedStops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      ['1:PICKUP', '2:PICKUP', '3:DROPOFF', '4:DROPOFF'],
    );
    assert.strictEqual(mine.body.data[0].proposedStops.filter((stop) => stop.isNew).length, 2);

    // Another driver sees nothing -- not the offer, and not the plan.
    const theirs = await asDriver(salauddinCookie, '/drivers/me/offers', { method: 'GET' });
    assert.strictEqual(theirs.status, 200);
    assert.deepStrictEqual(theirs.body.data, []);

    const peek = await asDriver(salauddinCookie, `/drivers/me/offers/${offerId}`, { method: 'GET' });
    assert.strictEqual(peek.status, 404, 'another driver cannot inspect the proposal');

    // A passenger cannot use the driver's endpoints at all.
    const passenger = await asDriver(nusratCookie, '/drivers/me/offers', { method: 'GET' });
    assert.strictEqual(passenger.status, 403);

    assert.strictEqual((await poolState(poolId)).version, 1);
  });

  it('does not let a client submit or alter the plan (category 29)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    const jashimCookie = await login('jashim@example.com');

    // A driver accepts or refuses. There is no shape of body that changes a stop
    // order, a score, a route, a detour or a capacity.
    const withBody = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/accept`, {
      body: { proposalSnapshot: { stops: [] }, score: 0, stopOrder: ['1:PICKUP', '2:DROPOFF'] },
    });
    assert.strictEqual(withBody.status, 400);
    assert.match(withBody.body.error.message, /Unsupported body field/);
    assert.match(withBody.body.error.message, /proposalSnapshot/);

    const rejectWithBody = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      body: { reason: 'TOO_FAR', stops: [] },
    });
    assert.strictEqual(rejectWithBody.status, 400);

    // The offer is untouched by either attempt.
    assert.strictEqual((await offerRow(offerId)).status, 'PENDING');
    assert.strictEqual((await poolState(poolId)).version, 1);

    // And an empty body accepts exactly the plan that was offered.
    const accepted = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/accept`);
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => `${stop.sequence}:${stop.stop_type}`),
      ['1:PICKUP', '2:PICKUP', '3:DROPOFF', '4:DROPOFF'],
      'the stored plan, and only the stored plan, was applied',
    );
  });

  it('changes nothing about the pool when the driver refuses (category 30)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });
    const rafiqRequest = await requestRide(rafiq);
    const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    const before = await poolState(poolId);
    const stopsBefore = await stopsOf(poolId);
    const eventsBefore = await poolEventTypes(poolId);

    const outcome = await offers.rejectOffer({
      driver: jashim,
      offerId,
      reason: 'TOO_FAR',
    });

    assert.strictEqual(outcome.rejected, true);
    assert.strictEqual(outcome.offerType, 'ADD_PASSENGER');
    assert.strictEqual(outcome.ridePoolId, poolId);

    assert.deepStrictEqual(await poolState(poolId), before, 'the pool is byte for byte the same');
    assert.deepStrictEqual(await stopsOf(poolId), stopsBefore);
    assert.deepStrictEqual(await poolEventTypes(poolId), eventsBefore);
    assert.strictEqual((await offerRow(offerId)).status, 'REJECTED');

    // The passenger is still waiting, and still has no member row.
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual((await memberIds(poolId)).length, 1);
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'RESERVED');

    // The existing passenger's own ride is untouched, too.
    assert.strictEqual(await requestStatus(nusratRequest.id), 'MATCHED');
    // The refusal was made through the service here, so nothing re-assigned the
    // request: re-assignment after a refusal is the caller's job (the driver
    // endpoint, covered by the category 31 test).
    assert.deepStrictEqual(await rideEventTypes(rafiqRequest.id), [
      'RIDE_REQUESTED',
      'POOL_CANDIDATE_EVALUATED',
      'POOL_JOIN_OFFERED',
      'POOL_JOIN_REJECTED',
    ]);
  });

  it('tries the next compatible pool after a refusal (category 31)', async () => {
    const first = await createInitialPool({ driver: jashim, passenger: nusrat });
    const second = await createInitialPool({ driver: salauddin, passenger: shirin });
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.ridePoolId, first.poolId, 'the older of two equal pools wins');

    const jashimCookie = await login('jashim@example.com');
    const refused = await asDriver(
      jashimCookie,
      `/drivers/me/offers/${offered.offerId}/reject`,
      { body: { reason: 'TOO_FAR' } },
    );
    assert.strictEqual(refused.status, 200);
    assert.strictEqual(refused.body.offerType, 'ADD_PASSENGER');
    assert.strictEqual(refused.body.ridePoolId, first.poolId);

    // The rejection itself triggers the next attempt: another compatible pool.
    const pending = (await offersFor(rafiqRequest.id)).filter((offer) => offer.status === 'PENDING');
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].ride_pool_id, second.poolId);
    assert.strictEqual(pending[0].driver_profile_id, salauddin.driverProfile.id);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');

    // The pool that refused is untouched, and the second one has not changed yet
    // either: it has only been offered.
    assert.strictEqual((await poolState(first.poolId)).version, 1);
    assert.strictEqual((await poolState(second.poolId)).version, 1);
    assert.strictEqual((await poolState(second.poolId)).members, 1);
  });

  it('tries the next candidate when the offer expires (category 32)', async () => {
    const first = await createInitialPool({ driver: jashim, passenger: nusrat });
    const second = await createInitialPool({ driver: salauddin, passenger: shirin });
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.ridePoolId, first.poolId);

    const expiredAt = new Date((await offerRow(offered.offerId)).expires_at);
    const summary = await dispatch.expireOverdueOffers({ now: expiredAt });

    assert.strictEqual(summary.expired, 1);
    assert.strictEqual(summary.redispatched, 1);

    const all = await offersFor(rafiqRequest.id);
    assert.deepStrictEqual(all.map((offer) => offer.status), ['EXPIRED', 'PENDING']);
    assert.strictEqual(all[1].ride_pool_id, second.poolId);

    // An expired offer is not a plan change: neither pool moved.
    assert.deepStrictEqual(
      { version: (await poolState(first.poolId)).version, members: (await poolState(first.poolId)).members },
      { version: 1, members: 1 },
    );
    assert.strictEqual((await poolState(second.poolId)).version, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.deepStrictEqual(await rideEventTypes(rafiqRequest.id), [
      'RIDE_REQUESTED',
      'POOL_CANDIDATE_EVALUATED',
      'POOL_JOIN_OFFERED',
      'DRIVER_OFFER_EXPIRED',
      'POOL_CANDIDATE_EVALUATED',
      'POOL_JOIN_OFFERED',
    ]);
  });

  it('falls back to a driver of their own when every pool has refused (category 33)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    await createInitialPool({ driver: salauddin, passenger: shirin });

    // A third driver, available and able to reach the pickup, is what the
    // fallback is for.
    await goOnline(karim, POINTS.MID);

    const rafiqRequest = await requestRide(rafiq);
    const first = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.rejectOffer({ driver: jashim, offerId: first.offerId, reason: 'TOO_FAR' });

    // The service refusal does not re-assign -- that is the caller's job -- so
    // the orchestrator is called for the next option explicitly.
    await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    const second = (await offersFor(rafiqRequest.id)).find((offer) => offer.status === 'PENDING');
    assert.strictEqual(second.offer_type, 'ADD_PASSENGER');
    await offers.rejectOffer({ driver: salauddin, offerId: second.id, reason: 'TOO_FAR' });

    // Both pools have now said no, so the request gets an initial offer of its
    // own -- the same RideRequest, still WAITING, and no new pool.
    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.strictEqual(outcome.assigned, true);
    assert.strictEqual(outcome.driverProfileId, karim.driverProfile.id);
    assert.strictEqual((await offerRow(outcome.offerId)).offer_type, 'INITIAL_RIDE');

    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual(await driverStatus(karim.driverProfile.id), 'AVAILABLE');
    assert.strictEqual((await counts()).pools, 2, 'no third pool while the offer is pending');

    const events = await listRideEvents(rafiqRequest.id);
    const types = events.map((event) => event.eventType);
    assert.deepStrictEqual(types.slice(-4), [
      'POOL_JOIN_OFFERED',
      'POOL_JOIN_REJECTED',
      'INITIAL_DISPATCH_FALLBACK',
      'DRIVER_OFFERED',
    ]);

    // Both pools are excluded for this passenger now, so the fallback reason is
    // "there is nothing left to try" rather than "a plan was refused".
    const fallback = events.filter((event) => event.eventType === 'INITIAL_DISPATCH_FALLBACK').at(-1);
    assert.strictEqual(fallback.metadata.reason, 'no_candidate_pools');
    assert.strictEqual(fallback.metadata.candidatePools, 0);
    assert.strictEqual(types.filter((type) => type === 'POOL_JOIN_REJECTED').length, 2);
  });

  it('never creates an initial offer while a pool offer is pending (category 33)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    await goOnline(karim, POINTS.MID);

    const rafiqRequest = await requestRide(rafiq);
    const join = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(join.mode, 'POOL_JOIN');

    // A driver is available, and the orchestrator is called again: the pending
    // join stands, and no second offer of any kind appears.
    const again = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(again.reason, 'already_offered');
    assert.strictEqual(again.offerType, 'ADD_PASSENGER');

    assert.deepStrictEqual(
      (await offersFor(rafiqRequest.id)).map((offer) => offer.offer_type),
      ['ADD_PASSENGER'],
    );
    assert.strictEqual(await driverStatus(karim.driverProfile.id), 'AVAILABLE');
  });
});

// ========================================================================
// 6. Acceptance
// ========================================================================

describe('acceptance', () => {
  it('adds the passenger to the pool, atomically (categories 34-42)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });

    const [nusratMember] = await memberIds(poolId);
    const stopsBefore = await stopsOf(poolId);
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    const proposal = (await offerRow(offered.offerId)).proposal_snapshot;

    const accepted = await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });
    assert.strictEqual(accepted.joined, true);
    assert.strictEqual(accepted.pool.id, poolId);

    // 34, 35: one member, and exactly one pick-up and one drop-off.
    const members = await memberIds(poolId);
    assert.strictEqual(members.length, 2);
    const newMember = members.find((member) => member.ride_request_id === rafiqRequest.id);
    assert.ok(newMember, 'the joining passenger has a member row');
    assert.strictEqual(newMember.status, 'ASSIGNED');

    const stops = await stopsOf(poolId);
    assert.strictEqual(stops.length, 4);
    const added = stops.filter((stop) => stop.ride_request_id === rafiqRequest.id);
    assert.strictEqual(added.length, 2);
    assert.deepStrictEqual(
      added.map((stop) => stop.stop_type).sort(),
      ['DROPOFF', 'PICKUP'],
    );
    assert.deepStrictEqual(
      added.map((stop) => stop.service_point_code).sort(),
      [POINTS.DESTINATION, POINTS.PICKUP].sort(),
    );
    assert.ok(added.every((stop) => stop.pool_member_id === newMember.id));
    assert.ok(added.every((stop) => stop.status === 'PENDING'));

    // 36: the existing stops were resequenced, not recreated -- their ids and
    // their relative order survive.
    assert.strictEqual(stops.length, stopsBefore.length + 2);
    assert.deepStrictEqual(
      stops.filter((stop) => stop.ride_request_id === nusratRequest.id).map((stop) => stop.id),
      stopsBefore.map((stop) => stop.id),
    );
    assert.deepStrictEqual(
      stops.map((stop) => stop.sequence),
      [1, 2, 3, 4],
      'contiguous and unique, after the offset pass',
    );
    assert.notStrictEqual(stops[0].id, undefined);

    // 13: arrivals are the plan's, re-anchored to the acceptance instant, and
    // they still run in stop order.
    const arrivals = stops.map((stop) => new Date(stop.planned_arrival_at).getTime());

    // With the driver already standing at the pickup -- which the v2 rule now
    // requires -- the approach is zero seconds, so the first arrival *is* the
    // planning instant rather than a moment after it. "Every arrival is in the
    // future" is therefore no longer the property to assert; that arrivals exist
    // and do not run backwards is.
    assert.ok(
      arrivals.every((arrival) => Number.isFinite(arrival)),
      'every stop has a planned arrival',
    );
    arrivals.forEach((arrival, index) => {
      if (index > 0) assert.ok(arrival >= arrivals[index - 1], `stop ${index + 1} arrival order`);
    });

    // 37, 38: the route, the totals and the version all come from the plan.
    const state = await poolState(poolId);
    assert.strictEqual(state.version, 2, 'every accepted plan change increments the version');
    assert.strictEqual(state.members, 2);
    assert.strictEqual(state.stops, 4);
    assert.strictEqual(Number(state.planned_distance_meters), proposal.totalDistanceMeters);
    assert.strictEqual(state.planned_duration_seconds, proposal.totalDurationSeconds);
    assert.ok(state.geometry.startsWith('LINESTRING'));
    assert.ok(state.geometry_points >= 2);

    // 39: the request is matched, and so is the driver's commitment.
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'MATCHED');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'RESERVED');

    // 40: the existing passenger's ride is untouched.
    assert.strictEqual(await requestStatus(nusratRequest.id), 'MATCHED');
    assert.strictEqual(
      (await memberIds(poolId)).find((member) => member.id === nusratMember.id).status,
      'ASSIGNED',
    );
    assert.ok(
      stops
        .filter((stop) => stop.ride_request_id === nusratRequest.id)
        .every((stop) => stop.status === 'PENDING'),
    );

    // 42: the events, written in the same transaction.
    const rideEvents = await rideEventTypes(rafiqRequest.id);
    assert.deepStrictEqual(rideEvents.slice(-3), [
      'PASSENGER_MATCHED',
      'POOL_JOIN_ACCEPTED',
      // The join changed the plan, so it re-priced everybody: the joining
      // passenger's allocation is the last thing on their own timeline.
      'PASSENGER_FARE_ALLOCATED',
    ]);
    const poolEvents = await listPoolEvents(poolId);
    assert.deepStrictEqual(
      poolEvents.map((event) => event.eventType).slice(-4),
      [
        'MEMBER_ADDED',
        'ROUTE_PLAN_UPDATED',
        'SHARED_FARE_SUPERSEDED',
        'SHARED_FARE_CALCULATED',
      ],
    );

    // The passenger's own fare was allocated against the new pool version, and
    // the event carries only their amounts.
    const allocationEvent = (await listRideEvents(rafiqRequest.id)).at(-1);
    assert.strictEqual(allocationEvent.eventType, 'PASSENGER_FARE_ALLOCATED');
    assert.strictEqual(allocationEvent.metadata.poolVersion, 2);
    assert.strictEqual(allocationEvent.metadata.sharedFareRuleVersion, SHARED_FARE_RULE_VERSION);
    assert.strictEqual(allocationEvent.metadata.previousPooledFare, null, 'a new passenger has no cap');

    // The event's fare and the request's stored fare are the same amount, shown
    // at the two precisions they are kept at: the timeline is audience-facing and
    // presents a charged fare as the whole number of taka it is, while the column
    // holds the exact accepted value.
    const [{ fare }] = (
      await pool.query(`SELECT accepted_fare::text AS fare FROM ride_requests WHERE id = $1::uuid`, [
        rafiqRequest.id,
      ])
    ).rows;
    assert.strictEqual(allocationEvent.metadata.acceptedSoloFare, Number(fare).toFixed(0));

    const acceptedEvent = (await listRideEvents(rafiqRequest.id)).find(
      (event) => event.eventType === 'POOL_JOIN_ACCEPTED',
    );
    assert.strictEqual(acceptedEvent.metadata.poolVersionBefore, 1);
    assert.strictEqual(acceptedEvent.metadata.poolVersionAfter, 2);
    assert.strictEqual(acceptedEvent.metadata.ruleVersion, MATCHING_RULE_VERSION);
    assert.deepStrictEqual(acceptedEvent.metadata.stopOrder, [
      '1:PICKUP',
      '2:PICKUP',
      '3:DROPOFF',
      '4:DROPOFF',
    ]);

    const joined = poolEvents.find((event) => event.eventType === 'ROUTE_PLAN_UPDATED');
    assert.strictEqual(joined.eventType, 'ROUTE_PLAN_UPDATED');
    assert.strictEqual(joined.metadata.poolVersionBefore, 1);
    assert.strictEqual(joined.metadata.poolVersionAfter, 2);
    assert.strictEqual(joined.metadata.peakOccupancy, 2);
    assert.deepStrictEqual(joined.metadata.stopOrder, [
      '1:PICKUP',
      '2:PICKUP',
      '3:DROPOFF',
      '4:DROPOFF',
    ]);

    // The offer itself is closed out.
    const offer = await offerRow(offered.offerId);
    assert.strictEqual(offer.status, 'ACCEPTED');
    assert.ok(offer.responded_at);
  });

  it('does not touch anybody\'s fare (category 43)', async () => {
    const { request: nusratRequest } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const before = await moneyAndFares();
    const nusratFare = (await requestForAssignment(nusratRequest.id)).acceptedDistanceMeters;

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });

    const after = await moneyAndFares();
    assert.deepStrictEqual(after, before, 'sharing a ride must not re-price anything');

    // Each passenger still holds the solo fare their own quote froze.
    const rows = await pool.query(
      `SELECT id, accepted_fare::text AS fare, fare_quote_id FROM ride_requests
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[nusratRequest.id, rafiqRequest.id]],
    );
    assert.strictEqual(rows.rows.length, 2);
    assert.ok(rows.rows.every((row) => Number(row.fare) > 0));
    assert.notStrictEqual(rows.rows[0].fare_quote_id, rows.rows[1].fare_quote_id);
    assert.strictEqual(
      (await requestForAssignment(nusratRequest.id)).acceptedDistanceMeters,
      nusratFare,
    );

    // And the snapshot a driver was shown has no money in it.
    const snapshot = JSON.stringify((await offerRow(offered.offerId)).proposal_snapshot);
    assert.doesNotMatch(snapshot, /fare|price|amount|currency|discount|taka|bdt/i);
  });

  it('accepts an initial offer for the same request after every pool refused (categories 33, 34)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await goOnline(karim, POINTS.MID);

    const rafiqRequest = await requestRide(rafiq);
    const join = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.rejectOffer({ driver: jashim, offerId: join.offerId, reason: 'TOO_FAR' });

    const fallback = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(fallback.mode, 'INITIAL_RIDE');

    const accepted = await offers.acceptOffer({ driver: karim, offerId: fallback.offerId });
    assert.strictEqual(accepted.joined, false);
    assert.notStrictEqual(accepted.pool.id, poolId, 'the fallback starts a pool of its own');

    // Both pools exist, each with exactly one member, and the first one was not
    // touched by the fallback.
    assert.strictEqual((await memberIds(accepted.pool.id)).length, 1);
    assert.strictEqual((await memberIds(poolId)).length, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'MATCHED');
    assert.strictEqual((await counts()).pools, 2);
  });
});

// ========================================================================
// 7. Concurrency
// ========================================================================

describe('concurrency', () => {
  it('lets only one of two requests take a pool\'s last seat (category 44)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const first = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.acceptOffer({ driver: jashim, offerId: first.offerId });
    assert.strictEqual((await poolState(poolId)).members, 2);

    // Two passengers, one seat. The seat is contended at *offer* time -- one pool
    // may have only one pending route change -- so the invariant is that exactly
    // one of them can hold it, whichever wins.
    const shirinRequest = await requestRide(shirin);
    const tahmidRequest = await requestRide(tahmid);

    const results = await Promise.allSettled([
      assignment.assignWaitingRequest({ rideRequestId: shirinRequest.id }),
      assignment.assignWaitingRequest({ rideRequestId: tahmidRequest.id }),
    ]);

    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['fulfilled', 'fulfilled'],
      'a race for a seat is a controlled answer, not a unique violation',
    );

    const poolOffers = (await pool.query(
      `SELECT id, ride_request_id FROM dispatch_offers
        WHERE ride_pool_id = $1::uuid AND status = 'PENDING'`,
      [poolId],
    )).rows;
    assert.strictEqual(poolOffers.length, 1, 'one pending route change per pool');

    const holder = poolOffers[0].ride_request_id;
    const other = holder === shirinRequest.id ? tahmidRequest.id : shirinRequest.id;
    assert.strictEqual(await requestStatus(holder), 'WAITING');

    // The other passenger is left waiting with no offer at all -- nobody else has
    // a car to spare -- and the pool still holds exactly one free seat.
    assert.strictEqual((await offersFor(other)).length, 0);
    assert.strictEqual(await requestStatus(other), 'WAITING');
    assert.strictEqual((await poolState(poolId)).members, 2);
    assert.strictEqual((await poolState(poolId)).version, 2);

    // Taking the seat closes it for good.
    await offers.acceptOffer({ driver: jashim, offerId: poolOffers[0].id });
    const full = await poolState(poolId);
    assert.strictEqual(full.members, 3);
    assert.strictEqual(full.capacity_snapshot, 3);

    const late = await assignment.assignWaitingRequest({ rideRequestId: other });
    assert.strictEqual(late.mode, 'INITIAL_RIDE');
    assert.strictEqual(
      (await offersFor(other)).filter((offer) => offer.offer_type === 'ADD_PASSENGER').length,
      0,
      'a full pool is never offered again',
    );
    assert.strictEqual((await poolState(poolId)).members, 3, 'and never over capacity');
  });

  it('creates one member when the same join offer is accepted twice at once (categories 44, 46)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    const results = await Promise.allSettled([
      offers.acceptOffer({ driver: jashim, offerId }),
      offers.acceptOffer({ driver: jashim, offerId }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 1, `exactly one acceptance may succeed`);

    const rejected = results.filter((result) => result.status === 'rejected');
    assert.strictEqual(rejected[0].reason.statusCode, 409);

    const state = await poolState(poolId);
    assert.strictEqual(state.members, 2);
    assert.strictEqual(state.stops, 4);
    assert.strictEqual(state.version, 2, 'one accepted plan is one version');
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'MATCHED');
    assert.strictEqual((await offerRow(offerId)).status, 'ACCEPTED');

    // One member and one set of stops, not two: the loser wrote nothing.
    assert.strictEqual((await memberIds(poolId)).filter((m) => m.ride_request_id === rafiqRequest.id).length, 1);
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => stop.sequence),
      [1, 2, 3, 4],
    );

    const poolEvents = await poolEventTypes(poolId);
    assert.deepStrictEqual(poolEvents.slice(-4), [
      'MEMBER_ADDED',
      'ROUTE_PLAN_UPDATED',
      'SHARED_FARE_SUPERSEDED',
      'SHARED_FARE_CALCULATED',
    ]);
    assert.strictEqual(
      poolEvents.filter((type) => type === 'MEMBER_ADDED').length,
      2,
      'one member event for the fixture passenger and one for the joiner',
    );
    assert.strictEqual(poolEvents.filter((type) => type === 'ROUTE_PLAN_UPDATED').length, 1);
  });

  it('refuses an offer made against an older pool version (category 45)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

    const before = await poolState(poolId);
    const stopsBefore = await stopsOf(poolId);

    // Somebody else re-planned the pool after this offer was made.
    await pool.query(`UPDATE ride_pools SET version = version + 1 WHERE id = $1::uuid`, [poolId]);

    await assert.rejects(
      () => offers.acceptOffer({ driver: jashim, offerId }),
      (err) => err.statusCode === 409 && /changed since the offer was made/.test(err.message),
    );

    // Nothing was written: not a member, not a stop, not a version.
    assert.deepStrictEqual(await poolState(poolId), { ...before, version: before.version + 1 });
    assert.deepStrictEqual(await stopsOf(poolId), stopsBefore);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'RESERVED');

    // The offer is cancelled rather than left pending: nothing should keep
    // waiting on a stale plan.
    assert.strictEqual((await offerRow(offerId)).status, 'CANCELLED');
    const events = await listRideEvents(rafiqRequest.id);
    assert.strictEqual(events.at(-1).eventType, 'DRIVER_OFFER_CANCELLED');
    assert.strictEqual(events.at(-1).metadata.reason, 'stale_pool_version');
    assert.strictEqual(events.at(-1).metadata.offeredPoolVersion, 1);
    assert.strictEqual(events.at(-1).metadata.currentPoolVersion, 2);

    // And the request can be offered its next option: the pool is still forming,
    // so it is a candidate again -- but against the *new* version, with a plan
    // built from the stops that exist now. Nothing is remembered about the stale
    // plan, which is the point of versioning it.
    const reassigned = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(reassigned.mode, 'POOL_JOIN');
    assert.strictEqual(reassigned.poolVersion, 2);
    assert.strictEqual((await offerRow(reassigned.offerId)).pool_version, 2);
    assert.notStrictEqual(reassigned.offerId, offerId);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
  });

  it('produces one legal outcome when a cancellation races an acceptance (category 46)', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await resetDispatchState();

      // eslint-disable-next-line no-await-in-loop
      const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
      // eslint-disable-next-line no-await-in-loop
      const rafiqRequest = await requestRide(rafiq);
      // eslint-disable-next-line no-await-in-loop
      const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled([
        offers.acceptOffer({ driver: jashim, offerId }),
        cancelRideRequest({ passenger: rafiq, rideRequestId: rafiqRequest.id, reason: 'CHANGED_MIND' }),
      ]);

      // eslint-disable-next-line no-await-in-loop
      const status = await requestStatus(rafiqRequest.id);
      // eslint-disable-next-line no-await-in-loop
      const state = await poolState(poolId);
      // eslint-disable-next-line no-await-in-loop
      const members = await memberIds(poolId);

      if (status === 'MATCHED') {
        assert.strictEqual(state.members, 2, `attempt ${attempt}: a matched request has a member`);
        assert.strictEqual(members.filter((m) => m.ride_request_id === rafiqRequest.id).length, 1);
        assert.strictEqual(state.version, 2);
      } else {
        assert.strictEqual(status, 'CANCELLED', `attempt ${attempt}: ${status}`);
        assert.strictEqual(state.members, 1, 'a cancelled ride must not join the pool');
        assert.strictEqual(state.stops, 2);
        assert.strictEqual(state.version, 1);
        assert.strictEqual(
          members.filter((m) => m.ride_request_id === rafiqRequest.id).length,
          0,
          'no member for a cancelled ride',
        );
      }

      // Whichever won, exactly one of the two operations succeeded.
      const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
      assert.ok(fulfilled >= 1, `attempt ${attempt}: somebody has to win`);
      assert.deepStrictEqual(
        (await stopsOf(poolId)).map((stop) => stop.sequence),
        state.stops === 2 ? [1, 2] : [1, 2, 3, 4],
      );
    }
  });

  it('produces one legal outcome when an expiry races an acceptance (category 47)', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await resetDispatchState();

      // eslint-disable-next-line no-await-in-loop
      const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
      // eslint-disable-next-line no-await-in-loop
      const rafiqRequest = await requestRide(rafiq);
      // eslint-disable-next-line no-await-in-loop
      const { offerId } = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });

      const offer = await offerRow(offerId);
      const deadline = new Date(offer.expires_at);

      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([
        offers.acceptOffer({ driver: jashim, offerId, now: deadline }),
        dispatch.expireOverdueOffers({ now: deadline }),
      ]);

      // eslint-disable-next-line no-await-in-loop
      const state = await poolState(poolId);
      // eslint-disable-next-line no-await-in-loop
      const closed = await offerRow(offerId);

      assert.ok(
        ['ACCEPTED', 'EXPIRED'].includes(closed.status),
        `attempt ${attempt}: ${closed.status}`,
      );

      if (closed.status === 'ACCEPTED') {
        assert.strictEqual(state.members, 2);
        assert.strictEqual(state.version, 2);
        assert.strictEqual(await requestStatus(rafiqRequest.id), 'MATCHED');
      } else {
        assert.strictEqual(state.members, 1, 'an expired offer changes nothing');
        assert.strictEqual(state.stops, 2);
        assert.strictEqual(state.version, 1);
        assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
      }
    }
  });

  it('keeps stop sequences unique and contiguous through repeated resequencing (category 49)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const joinAs = async (passenger) => {
      const request = await requestRide(passenger);
      const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
      assert.strictEqual(offered.mode, 'POOL_JOIN', `${passenger.email ?? 'passenger'}: no join`);
      await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });
      return request;
    };

    await joinAs(rafiq);
    await joinAs(tahmid);

    const stops = await stopsOf(poolId);
    assert.deepStrictEqual(
      stops.map((stop) => stop.sequence),
      [1, 2, 3, 4, 5, 6],
      'the offset pass leaves the numbers contiguous',
    );
    assert.strictEqual(new Set(stops.map((stop) => stop.id)).size, stops.length);

    // Each member keeps exactly one pick-up and one drop-off, in that order.
    for (const member of await memberIds(poolId)) {
      const own = stops.filter((stop) => stop.pool_member_id === member.id);
      assert.strictEqual(own.length, 2);
      assert.deepStrictEqual(
        own.map((stop) => stop.stop_type),
        ['PICKUP', 'DROPOFF'],
      );
    }

    const state = await poolState(poolId);
    assert.strictEqual(state.version, 3);
    assert.strictEqual(state.members, 3);

    // A fourth passenger has nowhere to sit: the pool is full, and stays full.
    // The passenger is left behind for the suite's own teardown to remove --
    // deleting them here would cascade into their ride events, and an event that
    // names them as its actor cannot be edited away.
    const latecomer = await createTestPassenger('latecomer@example.com');
    const lateRequest = await requestRide(latecomer);
    const late = await assignment.assignWaitingRequest({ rideRequestId: lateRequest.id });
    assert.strictEqual(late.mode, 'INITIAL_RIDE');
    assert.strictEqual((await poolState(poolId)).members, 3);
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => stop.sequence),
      [1, 2, 3, 4, 5, 6],
    );
  });
});

// ========================================================================
// 8. The demo scenario
// ========================================================================

describe('the demo scenario', () => {
  it('finds the Banani pool for a later compatible request, and its driver decides (categories 50-53)', async () => {
    // 1. An existing pool: Nusrat, with Jashim, from Banani Road 11 to Mohakhali.
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });

    const initial = await poolState(poolId);
    assert.strictEqual(initial.status, 'FORMING');
    assert.strictEqual(initial.version, 1);
    assert.strictEqual(initial.members, 1);
    assert.strictEqual(initial.stops, 2);

    // 2. A compatible waiting request from Rafiq: the same journey.
    const rafiqRequest = await requestRide(rafiq);

    // 3. Assignment finds the pool, and offers a join -- not a new driver.
    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');
    assert.strictEqual(offered.ridePoolId, poolId);
    assert.strictEqual(offered.driverProfileId, jashim.driverProfile.id);
    assert.strictEqual(offered.candidatePools, 1);
    assert.strictEqual(offered.evaluatedPlans, 6);

    const offer = await offerRow(offered.offerId);
    assert.strictEqual(offer.offer_type, 'ADD_PASSENGER');
    assert.strictEqual(offer.pool_version, 1);

    // 4. The passenger is still waiting, and the pool has not moved.
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual((await poolState(poolId)).members, 1);

    // 5. The driver refuses: nothing changes, and the request goes to the
    //    dispatcher because there is no other pool.
    await offers.rejectOffer({ driver: jashim, offerId: offered.offerId, reason: 'TOO_FAR' });
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.deepStrictEqual(await poolState(poolId), initial);
    assert.strictEqual((await poolState(poolId)).version, 1);

    // 6. The same request is offered again, and this time the driver accepts.
    const second = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(second.mode, 'INITIAL_RIDE', 'no other pool, and no driver either');
    assert.strictEqual(second.assigned, false);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');

    // 7. A fresh request (the refusal excluded Rafiq from this pool for good),
    //    accepted by the driver.
    const third = await requestRide(tahmid);
    const thirdOffer = await assignment.assignWaitingRequest({ rideRequestId: third.id });
    assert.strictEqual(thirdOffer.mode, 'POOL_JOIN');

    const accepted = await offers.acceptOffer({ driver: jashim, offerId: thirdOffer.offerId });
    assert.strictEqual(accepted.joined, true);

    // 8. Everything the brief asks to be verified afterwards.
    const grown = await poolState(poolId);
    assert.strictEqual(grown.version, 2);
    assert.strictEqual(grown.members, 2);
    assert.strictEqual(grown.stops, 4);
    assert.strictEqual(await requestStatus(third.id), 'MATCHED');
    assert.strictEqual(await requestStatus(nusratRequest.id), 'MATCHED');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'RESERVED');
    assert.deepStrictEqual(
      (await stopsOf(poolId)).map((stop) => `${stop.sequence}:${stop.stop_type}:${stop.service_point_code}`),
      [
        `1:PICKUP:${POINTS.PICKUP}`,
        `2:PICKUP:${POINTS.PICKUP}`,
        `3:DROPOFF:${POINTS.DESTINATION}`,
        `4:DROPOFF:${POINTS.DESTINATION}`,
      ],
    );
  });

  it('will not put a Banani Road 11 pool and a Mohakhali pickup in one car', async () => {
    // The redesigned rule, stated as a refusal. Two rides share a car *if and only
    // if* they start from the same service point, so a pool already running from
    // Banani Road 11 cannot collect somebody waiting at the Mohakhali Bus
    // Terminal however close the two are. A shared start is the rule, not a
    // preference, and this pair is the one that used to be allowed on a radius.
    const { poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      origin: 'banani-road-11',
      destination: 'gulshan-1-circle',
    });

    const rafiqRequest = await requestRide(rafiq, {
      origin: 'mohakhali-bus-terminal',
      destination: 'gulshan-1-circle',
    });

    assert.strictEqual(
      (await candidatesFor(rafiqRequest.id)).length,
      0,
      'a different starting point is not even a candidate pool',
    );

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.mode, 'INITIAL_RIDE', 'a car of their own instead');

    // Nothing about the existing pool moved.
    assert.strictEqual((await poolState(poolId)).members, 1);
  });

  it('fills the third seat with passengers who share the Banani Road 11 corridor', async () => {
    // Three passengers, all waiting at Banani Road 11, and a three-seat car: the
    // last seat the vehicle has. Two are bound for a Gulshan circle each and the
    // third for the one the first is going to, so every stop after the pickups is
    // somewhere the car was already going.
    const { poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      origin: 'banani-road-11',
      destination: 'gulshan-1-circle',
    });

    const secondRequest = await requestRide(rafiq, {
      origin: 'banani-road-11',
      destination: 'gulshan-2-circle',
    });
    const secondOffer = await assignment.assignWaitingRequest({ rideRequestId: secondRequest.id });
    assert.strictEqual(secondOffer.mode, 'POOL_JOIN');
    await offers.acceptOffer({ driver: jashim, offerId: secondOffer.offerId });

    const thirdRequest = await requestRide(shirin, {
      origin: 'banani-road-11',
      destination: 'gulshan-1-circle',
    });
    const thirdOffer = await assignment.assignWaitingRequest({ rideRequestId: thirdRequest.id });
    assert.strictEqual(thirdOffer.mode, 'POOL_JOIN');

    const accepted = await offers.acceptOffer({ driver: jashim, offerId: thirdOffer.offerId });
    assert.strictEqual(accepted.joined, true);

    const grown = await poolState(poolId);
    assert.strictEqual(grown.members, 3, 'three passengers from one corner');
    assert.strictEqual(grown.stops, 6);
    assert.strictEqual(grown.capacity_snapshot, 3, 'and that is the car full');

    const stops = (await stopsOf(poolId)).map((stop) => `${stop.stop_type}:${stop.service_point_code}`);

    // All three are collected at the same corner before anybody is set down.
    assert.deepStrictEqual(stops.slice(0, 3), [
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
    ]);

    // The order the two circles are visited in is the router's business, so this
    // asserts the set rather than a sequence that traffic could reorder.
    assert.deepStrictEqual([...stops].sort(), [
      'DROPOFF:gulshan-1-circle',
      'DROPOFF:gulshan-1-circle',
      'DROPOFF:gulshan-2-circle',
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
    ]);

    const billed = await pool
      .query(
        `SELECT rr.accepted_fare::text AS solo_fare, a.final_fare::text AS pooled_fare
           FROM passenger_fare_allocations a
           JOIN ride_requests rr ON rr.id = a.ride_request_id
           JOIN pool_fare_calculations c ON c.id = a.fare_calculation_id
          WHERE c.ride_pool_id = $1::uuid AND c.status = 'CURRENT'`,
        [poolId],
      )
      .then((result) => result.rows);

    assert.strictEqual(billed.length, 3, 'all three passengers are billed');
    for (const row of billed) {
      assert.ok(Number(row.pooled_fare) <= Number(row.solo_fare));
    }
  });

  it('shares a car between Banani Road 11 -> Gulshan 1 Circle and Banani Road 11 -> Mohakhali', async () => {
    // The demo's headline share: two passengers waiting at the *same corner*,
    // getting out at places either side of it. Under the redesigned rule that is
    // exactly what makes it eligible --
    //
    //   * both start from Banani Road 11, and
    //   * each destination is reachable from the other (the seed carries a direct
    //     Gulshan 1 Circle <-> Mohakhali Bus Terminal edge), so the car can serve
    //     one and then the other.
    //
    // No waiting, duration or detour limit is consulted, because that is the rule
    // now: the shape of the two journeys decides, not how far apart they are.
    const { poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      origin: 'banani-road-11',
      destination: 'gulshan-1-circle',
    });

    const rafiqRequest = await requestRide(rafiq, {
      origin: 'banani-road-11',
      destination: 'mohakhali-bus-terminal',
    });

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');

    const accepted = await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });
    assert.strictEqual(accepted.joined, true);

    const grown = await poolState(poolId);
    assert.strictEqual(grown.members, 2);
    assert.strictEqual(grown.stops, 4);

    const stops = (await stopsOf(poolId)).map((stop) => `${stop.stop_type}:${stop.service_point_code}`);

    // Both are collected at the corner before either is set down.
    assert.deepStrictEqual(stops.slice(0, 2), [
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
    ]);

    // Which of the two destinations is served first is the router's business, so
    // this asserts the set rather than an order traffic could reorder.
    assert.deepStrictEqual([...stops].sort(), [
      'DROPOFF:gulshan-1-circle',
      'DROPOFF:mohakhali-bus-terminal',
      'PICKUP:banani-road-11',
      'PICKUP:banani-road-11',
    ]);

    // The passenger who rides further still never pays more than the solo quote
    // they accepted. That is the guarantee that makes the detour acceptable.
    const billed = await pool
      .query(
        `SELECT rr.accepted_fare::text AS solo_fare, a.final_fare::text AS pooled_fare
           FROM passenger_fare_allocations a
           JOIN ride_requests rr ON rr.id = a.ride_request_id
           JOIN pool_fare_calculations c ON c.id = a.fare_calculation_id
          WHERE c.ride_pool_id = $1::uuid AND c.status = 'CURRENT'`,
        [poolId],
      )
      .then((result) => result.rows);

    assert.strictEqual(billed.length, 2, 'both passengers are billed');
    for (const row of billed) {
      assert.ok(
        Number(row.pooled_fare) <= Number(row.solo_fare),
        `pooled fare ${row.pooled_fare} must not exceed the accepted solo fare ${row.solo_fare}`,
      );
    }
  });

  // Removed in the v2 redesign: there is no destination *prefilter* to assert
  // against. A destination far from the pool no longer keeps the pool out of the
  // shortlist -- the pool is considered and the insertion is what decides, by
  // trying to route between the two drop-offs. The refusal case is the
  // reachability one above; a destination that *is* reachable now joins.

  it('keeps the request WAITING through the whole refusal path, never MATCHED (category 53)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.rejectOffer({ driver: jashim, offerId: offered.offerId, reason: 'TOO_FAR' });

    // No driver is available, so the request waits -- and is still cancellable.
    await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual((await counts()).pools, 1);

    const cancelled = await cancelRideRequest({
      passenger: rafiq,
      rideRequestId: rafiqRequest.id,
      reason: 'WAIT_TOO_LONG',
    });
    assert.strictEqual(cancelled.status, 'CANCELLED');
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'CANCELLED');

    // Cancelling never joined the pool, and never touched the pool's own state.
    assert.strictEqual((await poolState(poolId)).members, 1);
    assert.strictEqual((await poolState(poolId)).version, 1);
    assert.strictEqual((await memberIds(poolId)).length, 1);
  });

  it('does not match a request whose search window has closed (category 58)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const rafiqRequest = await requestRide(rafiq);
    const request = await requestForAssignment(rafiqRequest.id);

    // Past the search deadline the orchestrator does nothing at all: no pool
    // search, no offer, and not a match.
    const outcome = await assignment.assignWaitingRequest({
      rideRequestId: rafiqRequest.id,
      now: new Date(request.searchExpiresAt.getTime() + 1000),
    });

    assert.deepStrictEqual(outcome, { assigned: false, reason: 'search_window_closed' });
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
    assert.strictEqual((await poolState(poolId)).members, 1);
    assert.deepStrictEqual(await offersFor(rafiqRequest.id), []);
  });
});

// ========================================================================
// 9. Scope
// ========================================================================

describe('scope', () => {
  const source = (relative) =>
    readFile(new URL(`../../src/${relative}`, import.meta.url), 'utf8');

  /**
   * The comments in these modules deliberately *talk* about money -- to say that
   * matching does not touch it. What must not mention it is the code.
   */
  const withoutComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('introduces no shared-fare calculation (category 56)', async () => {
    const [rules, service] = await Promise.all([
      source('services/matching.rules.js'),
      source('services/matching.service.js'),
    ]);

    for (const text of [rules, service]) {
      const code = withoutComments(text);
      assert.doesNotMatch(code, /fare|price|amount|discount|bdt|taka/i);
      assert.doesNotMatch(code, /fare\.service|pricing\.service/);
    }

    // The joining passenger keeps the solo fare their own accepted quote froze,
    // and no money row is written by the join.
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);
    const before = await moneyAndFares();

    const offered = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    await offers.acceptOffer({ driver: jashim, offerId: offered.offerId });

    assert.deepStrictEqual(await moneyAndFares(), before);
    assert.strictEqual((await poolState(poolId)).members, 2);

    const { rows } = await pool.query(
      `SELECT accepted_fare::text AS fare FROM ride_requests WHERE id = $1::uuid`,
      [rafiqRequest.id],
    );
    assert.ok(Number(rows[0].fare) > 0, 'the passenger still holds their solo fare');
  });

  it('introduces no trip-operation endpoint of its own (category 57)', async () => {
    // This milestone neither performs nor exposes a trip operation. The trip
    // routes exist now, but every one of them is scoped to one driver's own pool
    // (`/drivers/me/pools/:poolId/...`) and none of them is reachable through the
    // paths a passenger or a different driver could guess at.
    //
    // The check reads the *route declarations* rather than the file's text: a
    // comment explaining that a pool may carry several passengers is prose, not a
    // route, and a test that fails on it is testing the wrong thing.
    const routes = await readFile(
      new URL('../../src/routes/driver.routes.js', import.meta.url),
      'utf8',
    );

    const declared = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)].map(
      (match) => match[2],
    );

    assert.ok(declared.length > 0, 'the route file really declares routes');
    for (const path of declared) {
      assert.doesNotMatch(path, /admin|passengers|\/trips\b/i, `${path} is not a driver path`);
    }

    assert.match(routes, /\/me\/pools\/:poolId\//, 'the trip is scoped to the driver\'s own pool');

    const cookie = await login('jashim@example.com');
    for (const path of [
      '/drivers/me/trips',
      '/drivers/me/trips/current/start',
      '/rides/current/complete',
      '/drivers/me/pool/stops/1/arrive',
      '/ride-requests/00000000-0000-4000-8000-000000000000/pickup',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await asDriver(cookie, path, { method: 'POST' });
      assert.strictEqual(response.status, 404, `${path} must not exist`);
    }

    // The driver's history reads are a pool per trip, addressed by the driver's own
    // pool id, so the boundary still holds: `/drivers/me/rides/{poolId}` is a
    // read of one of *their* pools and answers 404 for anybody else's.
    assert.ok(
      declared.some((path) => path === '/me/rides/:poolId'),
      'the history detail is scoped to one pool',
    );
  });

  it('never matches into a pool that has started (category 58)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const rafiqRequest = await requestRide(rafiq);

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 1);
    assert.deepStrictEqual(
      ELIGIBLE_POOL_STATUSES,
      ['FORMING'],
      'the eligible set is exactly one status',
    );

    // A pool that has begun moving is a commitment to the passengers already in
    // it, so it leaves the candidate set the moment it leaves FORMING. The
    // departure instant comes with the status: a pool cannot be under way without
    // having set off.
    await pool.query(
      `UPDATE ride_pools SET status = 'DRIVER_EN_ROUTE', departed_at = now() WHERE id = $1::uuid`,
      [poolId],
    );

    assert.strictEqual((await candidatesFor(rafiqRequest.id)).length, 0);

    const outcome = await assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id });
    assert.strictEqual(outcome.mode, 'INITIAL_RIDE');
    assert.deepStrictEqual(
      (await offersFor(rafiqRequest.id)).filter((offer) => offer.offer_type === 'ADD_PASSENGER'),
      [],
    );
    assert.strictEqual((await poolState(poolId)).members, 1);
    assert.strictEqual(await requestStatus(rafiqRequest.id), 'WAITING');
  });
});

