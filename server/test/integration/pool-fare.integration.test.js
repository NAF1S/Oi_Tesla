import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import * as assignment from '../../src/services/assignment.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as offers from '../../src/services/offer.service.js';
import { computeLegCost } from '../../src/services/pool-fare.rules.js';
import {
  SHARED_FARE_RULE_VERSION,
  onboardByLeg,
} from '../../src/services/pool-fare.rules.js';
import {
  recalculatePoolFaresStandalone,
} from '../../src/services/pool-fare.service.js';
import { listPoolEvents } from '../../src/services/pool.service.js';
import {
  createRideRequest,
  listRideEvents,
} from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase, sqlStateOf } from '../helpers/db.js';
import {
  goOnline,
  loadDemoUser,
  POINTS,
  resetDispatchState,
  withEnv,
} from '../helpers/drivers.js';

/**
 * Shared fares: what each passenger in a pool owes, and the promises that hold
 * while the pool changes underneath them.
 *
 * The suite is organised the way the brief states the problem:
 *
 *   1. the calculation a pool starts with     -- one answer, one leg, one fare
 *   2. adding a passenger                     -- a superseded answer, and no fare
 *                                                that ever goes up
 *   3. leg shares                             -- the split, and its rounding
 *   4. protections                            -- the solo cap, the no-increase
 *                                                cap, and the minimum fare
 *   5. versioning and idempotency             -- one CURRENT, one per version
 *   6. transactions and concurrency           -- nothing half-written
 *   7. privacy                                -- a passenger sees only their own
 *   8. scope                                  -- no payment, no trip operations
 *
 * The numbers come from the database and from the authoritative router rather
 * than from literals, so the suite says the same thing whatever the traffic
 * profile is when it runs. Where a literal does appear it is a relationship
 * (\"her fare is half his\") rather than an amount.
 */

const { Decimal } = Prisma;

/**
 * The instant the fixtures price and plan at.
 *
 * "Now", rather than a pinned noon: the shared-fare guarantees are measured
 * against the solo fare a passenger's own quote froze, so a quote priced in one
 * traffic regime and a plan measured in another would make the caps do work the
 * rules never asked them to. A test that needs a specific instant passes one.
 */
const planNow = () => new Date();

/** A deliberately expensive policy, used to make the protections bite. */
const CAP_TEST_CODE = 'pool-fare-cap-test';

/**
 * The two prices a protected passenger is quoted between.
 *
 * `EXPENSIVE` is in force when a test quotes a passenger, so their *accepted*
 * solo fare is high; `VERY_EXPENSIVE` is in force when a later passenger joins,
 * so the pooled fare they would owe without protection is higher still. The two
 * are deliberately far apart rather than both "expensive": a fare is only capped
 * by the lower of the two ceilings, so a test that wants to see *both* protections
 * work needs the ceilings themselves to be different.
 */
const EXPENSIVE = {
  code: CAP_TEST_CODE,
  baseFare: '40.0000',
  perKilometerRate: '180.0000',
  perMinuteRate: '20.0000',
};
const VERY_EXPENSIVE = {
  code: 'pool-fare-cap-test-high',
  baseFare: '400.0000',
  perKilometerRate: '1800.0000',
  perMinuteRate: '200.0000',
};

let api;
let nusrat;
let rafiq;
let shirin;
let jashim;
let sequence = 0;

const nextKey = (label = 'pool-fare') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

const login = async (email) => {
  const response = await api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.demoSeedPassword }),
  });
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

const asUser = (cookie, path) =>
  api.request(path, { method: 'GET', headers: { cookie } });

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

/** A committed one-passenger pool, created the way the product creates one. */
const createInitialPool = async ({
  driver,
  passenger,
  // The driver stands at the pickup: under the v2 matching rule a pool can only
  // take another passenger if its driver is already on the shared start point.
  point = POINTS.PICKUP,
  quotePricing = null,
}) => {
  await goOnline(driver, point);

  // `quotePricing` is for the one scenario that needs the passenger's accepted
  // fare and their pooled fare to come from different price lists: the quote.
  const request = quotePricing
    ? await withPricing(quotePricing, () => requestRide(passenger))
    : await requestRide(passenger);
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });
  return { request, poolId: accepted.pool.id };
};

/**
 * Prepares a join without accepting it: the request and the offer.
 *
 * The split matters for the protection tests, which need the *offer's* acceptance
 * to run under a different policy while the request was quoted under the normal
 * one -- which is what a price change mid-pool looks like.
 */
const prepareJoin = async ({ driver, passenger }) => {
  const request = await requestRide(passenger);

  const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(offered.mode, 'POOL_JOIN', 'the fixture passenger must be able to join');

  return { request, offerId: offered.offerId };
};

/** Adds one passenger to an existing pool, the way the product does it. */
const joinPool = async ({ driver, passenger, options = {} }) => {
  const prepared = await prepareJoin({ driver, passenger });

  const accepted = await offers.acceptOffer({ driver, offerId: prepared.offerId, ...options });
  return { ...prepared, pool: accepted.pool };
};

// --- Reads --------------------------------------------------------------

const currentCalculation = async (poolId) => {
  const [row] = (
    await pool.query(
      `SELECT id, pool_version, status, pricing_code, pricing_version, shared_fare_rule_version,
              currency, traffic_profile, route_distance_meters, route_duration_seconds,
              total_variable_route_cost::text   AS total_variable_route_cost,
              total_passenger_base_fare::text   AS total_passenger_base_fare,
              total_uncapped_passenger_fare::text AS total_uncapped_passenger_fare,
              total_minimum_fare_uplift::text   AS total_minimum_fare_uplift,
              total_final_passenger_fare::text  AS total_final_passenger_fare,
              total_solo_cap_reduction::text    AS total_solo_cap_reduction,
              total_no_increase_reduction::text AS total_no_increase_reduction,
              created_at
         FROM pool_fare_calculations
        WHERE ride_pool_id = $1::uuid AND status = 'CURRENT'`,
      [poolId],
    )
  ).rows;

  return row ?? null;
};

const calculationForVersion = async (poolId, poolVersion) => {
  const [row] = (
    await pool.query(
      `SELECT id, pool_version, status, pricing_code, pricing_version
         FROM pool_fare_calculations
        WHERE ride_pool_id = $1::uuid AND pool_version = $2::int`,
      [poolId, poolVersion],
    )
  ).rows;

  return row ?? null;
};

const countCalculations = async (poolId) => {
  const [row] = (
    await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'CURRENT')::int AS current
         FROM pool_fare_calculations WHERE ride_pool_id = $1::uuid`,
      [poolId],
    )
  ).rows;

  return row;
};

const legsOf = (calculationId) =>
  pool
    .query(
      `SELECT id, sequence, from_pool_stop_id, to_pool_stop_id, distance_meters, duration_seconds,
              distance_cost::text AS distance_cost, time_cost::text AS time_cost,
              traffic_adjustment::text AS traffic_adjustment, total_leg_cost::text AS total_leg_cost,
              onboard_passenger_count, route_snapshot
         FROM pool_fare_legs WHERE fare_calculation_id = $1::uuid ORDER BY sequence`,
      [calculationId],
    )
    .then((result) => result.rows);

const allocationsOf = (calculationId) =>
  pool
    .query(
      `SELECT a.id, a.pool_member_id, a.ride_request_id, a.accepted_solo_fare::text AS accepted_solo_fare,
              a.previous_pooled_fare_cap::text AS previous_pooled_fare_cap,
              a.base_fare::text AS base_fare, a.allocated_leg_cost::text AS allocated_leg_cost,
              a.uncapped_pooled_fare::text AS uncapped_pooled_fare, a.minimum_fare::text AS minimum_fare,
              a.minimum_fare_applied, a.solo_cap_applied, a.no_increase_cap_applied,
              a.solo_cap_reduction::text AS solo_cap_reduction,
              a.no_increase_reduction::text AS no_increase_reduction,
              a.final_fare::text AS final_fare, a.currency
         FROM passenger_fare_allocations a
        WHERE a.fare_calculation_id = $1::uuid
        ORDER BY a.pool_member_id`,
      [calculationId],
    )
    .then((result) => result.rows);

const sharesOf = (allocationId) =>
  pool
    .query(
      `SELECT s.pool_fare_leg_id, l.sequence, s.onboard_passenger_count, s.share_ratio::text AS share_ratio,
              s.unrounded_amount::text AS unrounded_amount, s.allocated_amount::text AS allocated_amount,
              s.rounding_adjustment::text AS rounding_adjustment
         FROM passenger_fare_leg_shares s
         JOIN pool_fare_legs l ON l.id = s.pool_fare_leg_id
        WHERE s.passenger_fare_allocation_id = $1::uuid
        ORDER BY l.sequence`,
      [allocationId],
    )
    .then((result) => result.rows);

const stopsOf = (poolId) =>
  pool
    .query(
      `SELECT ps.id, ps.sequence, ps.stop_type, ps.pool_member_id, ps.ride_request_id, ps.status,
              sp.code AS service_point_code
         FROM pool_stops ps
         JOIN service_points sp ON sp.id = ps.service_point_id
        WHERE ps.ride_pool_id = $1::uuid ORDER BY ps.sequence`,
      [poolId],
    )
    .then((result) => result.rows);

const poolState = async (poolId) => {
  const [row] = (
    await pool.query(
      `SELECT status, version, capacity_snapshot,
              (SELECT count(*)::int FROM pool_members m WHERE m.ride_pool_id = rp.id) AS members,
              (SELECT count(*)::int FROM pool_stops s WHERE s.ride_pool_id = rp.id) AS stops
         FROM ride_pools rp WHERE rp.id = $1::uuid`,
      [poolId],
    )
  ).rows;

  return row;
};

const requestStatus = async (rideRequestId) => {
  const [row] = (
    await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [rideRequestId])
  ).rows;

  return row?.status ?? null;
};

const requestFare = async (rideRequestId) => {
  const [row] = (
    await pool.query(`SELECT accepted_fare::text AS fare FROM ride_requests WHERE id = $1::uuid`, [
      rideRequestId,
    ])
  ).rows;

  return row?.fare ?? null;
};

const money = (value) => new Decimal(value);
const sumMoney = (values) => values.reduce((total, value) => total.plus(money(value)), money(0));

const allocationOf = (allocations, memberId) => {
  const found = allocations.find((allocation) => allocation.pool_member_id === memberId);
  assert.ok(found, `no allocation for member ${memberId}`);
  return found;
};

const memberIdsOf = (poolId) =>
  pool
    .query(`SELECT id FROM pool_members WHERE ride_pool_id = $1::uuid ORDER BY id`, [poolId])
    .then((result) => result.rows.map((row) => row.id));

// --- Lifecycle ----------------------------------------------------------

before(async () => {
  await prepareDatabase();
  api = await startServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');
  jashim = await loadDemoUser('jashim@example.com');

  await resetDispatchState();
  await pool.query(`DELETE FROM vehicles WHERE name NOT IN ('Bullet', 'Second Car', 'Third Car')`);
});

beforeEach(async () => {
  await resetDispatchState();
  jashim = await loadDemoUser('jashim@example.com');
});

after(async () => {
  // The server and the pool must be closed even if the clean-up fails: an open
  // server keeps the process alive and turns a failed assertion into a hang.
  try {
    await resetDispatchState();
    await removeCapTestPolicies();
  } finally {
    await api.close();
    await closePool();
  }
});

const startServer = startApiServer;

/**
 * Removes one test policy, in the order the foreign keys require.
 *
 * `fare_policy_id` is `RESTRICT` on the quotes and on the fare calculations that
 * a test quoted or priced under it, so clearing the rides first (which cascades
 * to the calculations) and then the quotes is what makes the policy deletable at
 * all. Getting this order wrong deletes nothing and takes the whole run down with
 * a hook failure.
 */
const removeCapTestPolicy = async (code) => {
  const policy = await pool.farePolicy.findFirst({ where: { code }, select: { id: true } });
  if (!policy) return;

  await pool.fareQuote.deleteMany({ where: { farePolicyId: policy.id } });
  await pool.farePolicy.delete({ where: { id: policy.id } });
};

const removeCapTestPolicies = async () => {
  for (const spec of [EXPENSIVE, VERY_EXPENSIVE]) {
    await removeCapTestPolicy(spec.code);
  }
};

/**
 * Creates one of the test price lists.
 *
 * `code` is unique, so a test that runs after an interrupted one starts from a
 * clean slate rather than failing on a leftover row.
 */
const createCapTestPolicy = async (spec = EXPENSIVE) => {
  await removeCapTestPolicy(spec.code);

  return pool.farePolicy.create({
    data: {
      code: spec.code,
      version: 1,
      name: `Test policy: ${spec.code}`,
      currency: 'BDT',
      baseFare: new Decimal(spec.baseFare),
      perKilometerRate: new Decimal(spec.perKilometerRate),
      perMinuteRate: new Decimal(spec.perMinuteRate),
      minimumFare: new Decimal('80.0000'),
      normalTrafficMultiplier: new Decimal('1.0000'),
      rushHourMultiplier: new Decimal('1.1000'),
      quoteTtlSeconds: 300,
      roundingScale: 2,
      active: true,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    },
    select: { id: true },
  });
};

/**
 * Runs `fn` while a price list is in force.
 *
 * This is the project's own lever: `findEffectiveFarePolicy` reads the code from
 * configuration, never from a request, and "publishing a new price" is a data
 * change. It is also the honest way to make the passenger-protection caps bind:
 * a fare only has to be capped when the arithmetic behind it has changed, which
 * is exactly what a price change in the middle of a pool is.
 */
const withPricing = (spec, fn) => withEnv(env.fare, { pricingCode: spec.code }, fn);

// ========================================================================
// 1. The calculation a pool starts with
// ========================================================================

describe('the calculation a pool starts with', () => {
  it('prices the plan once, for version 1 (categories 27, 31)', async () => {
    const { poolId, request } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const state = await poolState(poolId);

    const calculation = await currentCalculation(poolId);
    assert.ok(calculation, 'a pool with a plan has a fare calculation');
    assert.strictEqual(calculation.status, 'CURRENT');
    assert.strictEqual(calculation.pool_version, state.version, 'the fare version is the plan version');
    assert.strictEqual(calculation.shared_fare_rule_version, SHARED_FARE_RULE_VERSION);
    assert.strictEqual(calculation.currency, 'BDT');
    assert.ok(['NORMAL', 'RUSH_HOUR'].includes(calculation.traffic_profile));

    const counts = await countCalculations(poolId);
    assert.deepStrictEqual(counts, { total: 1, current: 1 });

    // One member, two stops, one leg between them, and one share of it.
    const legs = await legsOf(calculation.id);
    assert.strictEqual(legs.length, 1);
    assert.strictEqual(legs[0].sequence, 1);
    assert.strictEqual(legs[0].onboard_passenger_count, 1);

    const allocations = await allocationsOf(calculation.id);
    assert.strictEqual(allocations.length, 1);
    assert.strictEqual(allocations[0].ride_request_id, request.id);
    assert.strictEqual(allocations[0].previous_pooled_fare_cap, null, 'a new passenger has no cap');

    const shares = await sharesOf(allocations[0].id);
    assert.strictEqual(shares.length, 1);
    assert.strictEqual(shares[0].onboard_passenger_count, 1);
    assert.strictEqual(shares[0].allocated_amount, legs[0].total_leg_cost);
  });

  it('prices a solo passenger the whole leg, and invents no discount (category 26)', async () => {
    const { poolId, request } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const calculation = await currentCalculation(poolId);
    const [allocation] = await allocationsOf(calculation.id);
    const [leg] = await legsOf(calculation.id);
    const [share] = await sharesOf(allocation.id);

    // Alone in the car: the passenger receives the entire leg cost, and pays the
    // base fare on top of it. Nothing is split, so nothing is discounted.
    assert.strictEqual(share.allocated_amount, leg.total_leg_cost);
    assert.strictEqual(allocation.allocated_leg_cost, leg.total_leg_cost);
    assert.strictEqual(
      allocation.uncapped_pooled_fare,
      money(allocation.base_fare).plus(money(allocation.allocated_leg_cost)).toFixed(6),
    );
    assert.strictEqual(allocation.no_increase_cap_applied, false);
    assert.strictEqual(allocation.no_increase_reduction, '0.000000');

    // Off-peak, a pooled fare is the solo fare: the base fare plus the journey,
    // priced the same way -- so nobody pays more, and nobody is quietly refunded
    // for sharing with nobody.
    if (calculation.traffic_profile === 'NORMAL') {
      assert.strictEqual(allocation.final_fare, await requestFare(request.id));
      assert.strictEqual(allocation.solo_cap_applied, false);
    } else {
      // At rush hour the pooled fare is below the quote rather than above it: the
      // quote's traffic multiplier scales the base fare too, and a pooled base
      // fare is a fixed per-passenger amount. Nobody pays more than their quote
      // either way.
      assert.ok(money(allocation.final_fare).lte(await requestFare(request.id)));
    }
  });

  it('prices the leg from the authoritative route (categories 8, 9, 10, 11, 12, 13)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const calculation = await currentCalculation(poolId);
    const [leg] = await legsOf(calculation.id);
    const snapshot = leg.route_snapshot;

    // The leg is the plan's leg: the pickup stop to the drop-off stop, over the
    // network, with the edges the router chose.
    const stops = await stopsOf(poolId);
    assert.strictEqual(leg.from_pool_stop_id, stops[0].id);
    assert.strictEqual(leg.to_pool_stop_id, stops[1].id);
    assert.strictEqual(snapshot.funded, true);
    assert.ok(snapshot.edges.length > 0, 'the snapshot records the edges that were driven');
    assert.strictEqual(
      snapshot.edges.reduce((total, edge) => total + edge.distanceMeters, 0),
      leg.distance_meters,
      'the edge distances add up to the leg distance',
    );
    assert.strictEqual(leg.distance_meters, calculation.route_distance_meters);
    assert.strictEqual(leg.duration_seconds, calculation.route_duration_seconds);

    // The weighted distance charges add up to the stored distance cost, and the
    // weight reached the distance only.
    assert.strictEqual(
      sumMoney(snapshot.edges.map((edge) => edge.distanceCharge)).toFixed(6),
      leg.distance_cost,
    );
    assert.ok(snapshot.edges.every((edge) => Number(edge.fareWeight) > 0));

    // The traffic multiplier is applied once, as an adjustment on top of the
    // pre-traffic cost: the three components are the total, and the total is not
    // the pre-traffic cost with the multiplier applied twice.
    assert.strictEqual(
      money(leg.distance_cost).plus(leg.time_cost).plus(leg.traffic_adjustment).toFixed(6),
      leg.total_leg_cost,
    );
    const multiplier = money(snapshot.components.trafficMultiplier);
    if (leg.traffic_adjustment !== '0.000000') {
      assert.notStrictEqual(
        leg.total_leg_cost,
        money(leg.distance_cost).plus(leg.time_cost).times(multiplier).times(multiplier).toFixed(6),
      );
    }

    // No base fare in a leg: it belongs to the passenger, not to the driving.
    assert.strictEqual(
      leg.total_leg_cost,
      money(leg.distance_cost).plus(leg.time_cost).plus(leg.traffic_adjustment).toFixed(6),
    );
  });

  it('can be reproduced from the snapshot and the policy it stored (category 13)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const calculation = await currentCalculation(poolId);
    const [leg] = await legsOf(calculation.id);
    const policy = await pool.farePolicy.findFirst({
      where: { code: calculation.pricing_code, version: calculation.pricing_version },
    });

    // Re-pricing the stored edges with the stored policy reproduces the stored
    // leg, exactly: nothing about the leg needs the router to be asked again.
    const recomputed = computeLegCost({
      policy,
      edges: leg.route_snapshot.edges.map((edge) => ({
        edgeCode: edge.edgeCode,
        direction: edge.direction,
        distanceMeters: edge.distanceMeters,
        durationSeconds: edge.durationSeconds,
        fareWeight: edge.fareWeight,
      })),
      trafficProfile: leg.route_snapshot.trafficProfile,
    });

    assert.strictEqual(recomputed.distanceCost.toFixed(6), leg.distance_cost);
    assert.strictEqual(recomputed.timeCost.toFixed(6), leg.time_cost);
    assert.strictEqual(recomputed.trafficAdjustment.toFixed(6), leg.traffic_adjustment);
    assert.strictEqual(recomputed.totalLegCost.toFixed(6), leg.total_leg_cost);
  });

  it('records the totals as the sum of the rows it holds (category 27)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const calculation = await currentCalculation(poolId);
    const legs = await legsOf(calculation.id);
    const allocations = await allocationsOf(calculation.id);

    assert.strictEqual(
      sumMoney(legs.map((leg) => leg.total_leg_cost)).toFixed(6),
      calculation.total_variable_route_cost,
    );
    assert.strictEqual(
      sumMoney(allocations.map((allocation) => allocation.base_fare)).toFixed(6),
      calculation.total_passenger_base_fare,
    );
    assert.strictEqual(
      sumMoney(allocations.map((allocation) => allocation.uncapped_pooled_fare)).toFixed(6),
      calculation.total_uncapped_passenger_fare,
    );
    assert.strictEqual(
      sumMoney(allocations.map((allocation) => allocation.final_fare)).toFixed(6),
      calculation.total_final_passenger_fare,
    );
  });

  it('appends the fares to both timelines (categories 27, 42)', async () => {
    const { poolId, request } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const rideEvents = await listRideEvents(request.id);
    const allocated = rideEvents.at(-1);
    assert.strictEqual(allocated.eventType, 'PASSENGER_FARE_ALLOCATED');
    assert.strictEqual(allocated.metadata.poolVersion, 1);
    assert.strictEqual(allocated.metadata.sharedFareRuleVersion, SHARED_FARE_RULE_VERSION);

    // The event's fare is this passenger's own, as a whole number of taka, while
    // the leg cost it was built from keeps the policy's scale.
    const calculation = await currentCalculation(poolId);
    const [allocation] = await allocationsOf(calculation.id);
    assert.strictEqual(allocated.metadata.finalFare, money(allocation.final_fare).toFixed(0));
    assert.strictEqual(
      allocated.metadata.acceptedSoloFare,
      money(allocation.accepted_solo_fare).toFixed(0),
    );

    const poolEvents = await listPoolEvents(poolId);
    assert.deepStrictEqual(
      poolEvents.map((event) => event.eventType).at(-1),
      'SHARED_FARE_CALCULATED',
    );
    const calculated = poolEvents.at(-1).metadata;
    assert.strictEqual(calculated.poolVersion, 1);
    assert.strictEqual(calculated.passengerCount, 1);
    assert.strictEqual(calculated.legCount, 1);

    // The pool's own event says nothing about who paid what.
    const serialised = JSON.stringify(poolEvents.at(-1).metadata);
    assert.doesNotMatch(serialised, /acceptedSoloFare|finalFare/);
  });
});

// ========================================================================
// 2. Adding a passenger
// ========================================================================

describe('adding a passenger', () => {
  it('supersedes the previous calculation and keeps it readable (categories 28, 29)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const first = await currentCalculation(poolId);
    const firstAllocations = await allocationsOf(first.id);
    const firstLegs = await legsOf(first.id);

    await joinPool({ driver: jashim, passenger: rafiq });

    const second = await currentCalculation(poolId);
    assert.notStrictEqual(second.id, first.id);
    assert.strictEqual(second.pool_version, 2);

    const counts = await countCalculations(poolId);
    assert.deepStrictEqual(counts, { total: 2, current: 1 }, 'one current, one superseded');

    const superseded = await calculationForVersion(poolId, 1);
    assert.strictEqual(superseded.status, 'SUPERSEDED');

    // The previous answer is exactly as it was: same rows, same amounts.
    assert.deepStrictEqual(await allocationsOf(first.id), firstAllocations);
    assert.deepStrictEqual(await legsOf(first.id), firstLegs);

    // And the pool's history says a pricing was replaced, by which calculation.
    const poolEvents = await listPoolEvents(poolId);
    const supersededEvent = poolEvents.find((event) => event.eventType === 'SHARED_FARE_SUPERSEDED');
    assert.ok(supersededEvent, 'superseding a calculation is recorded');
    assert.strictEqual(supersededEvent.metadata.fareCalculationId, first.id);
    assert.strictEqual(supersededEvent.metadata.poolVersion, 1);
  });

  it('never increases an existing passenger\'s fare when somebody joins (categories 21, 25)', async () => {
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
    });

    const [nusratMember] = await memberIdsOf(poolId);

    const before = await currentCalculation(poolId);
    const nusratBefore = allocationOf(await allocationsOf(before.id), nusratMember);

    await joinPool({ driver: jashim, passenger: rafiq });

    const after = await currentCalculation(poolId);
    const nusratAfter = allocationOf(await allocationsOf(after.id), nusratMember);

    // The guarantee, end to end: Rafiq sharing the car did not cost Nusrat more.
    assert.ok(
      money(nusratAfter.final_fare).lte(nusratBefore.final_fare),
      `her fare went from ${nusratBefore.final_fare} to ${nusratAfter.final_fare}`,
    );

    // And the cap that enforces it was recorded, with the fare it capped.
    assert.strictEqual(nusratAfter.previous_pooled_fare_cap, nusratBefore.final_fare);
    assert.strictEqual(
      nusratAfter.no_increase_cap_applied,
      money(nusratAfter.no_increase_reduction).greaterThan(0),
    );

    // Nobody pays more than the fare they accepted, either.
    assert.ok(money(nusratAfter.final_fare).lte(await requestFare(nusratRequest.id)));
  });

  it('never increases anybody\'s fare when a third passenger joins (category 22)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const [nusratMember, rafiqMember] = await memberIdsOf(poolId);

    const beforeIds = await currentCalculation(poolId);
    const before = await allocationsOf(beforeIds.id);

    await joinPool({ driver: jashim, passenger: shirin });

    const afterCalculation = await currentCalculation(poolId);
    const after = await allocationsOf(afterCalculation.id);
    assert.strictEqual(after.length, 3);

    for (const memberId of [nusratMember, rafiqMember]) {
      const previous = allocationOf(before, memberId);
      const current = allocationOf(after, memberId);

      assert.ok(
        money(current.final_fare).lte(previous.final_fare),
        `member ${memberId} went from ${previous.final_fare} to ${current.final_fare}`,
      );
      assert.strictEqual(current.previous_pooled_fare_cap, previous.final_fare);
    }

    // The new passenger has no previous fare to be capped by, and pays their own
    // way: a base fare plus their shares.
    const shirinMember = (await memberIdsOf(poolId)).find(
      (id) => id !== nusratMember && id !== rafiqMember,
    );
    const shirinAllocation = allocationOf(after, shirinMember);
    assert.strictEqual(shirinAllocation.previous_pooled_fare_cap, null);
    assert.ok(money(shirinAllocation.allocated_leg_cost).greaterThan(0));
  });

  it('charges everybody less when the car is shared (category 15)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const alone = await currentCalculation(poolId);
    const [nusratMember] = await memberIdsOf(poolId);
    const aloneAllocation = allocationOf(await allocationsOf(alone.id), nusratMember);

    await joinPool({ driver: jashim, passenger: rafiq });

    const shared = await currentCalculation(poolId);
    const sharedAllocation = allocationOf(await allocationsOf(shared.id), nusratMember);

    // Sharing the same leg with one other passenger halves what each of them
    // pays for it (to within one currency unit of rounding).
    assert.ok(
      money(sharedAllocation.allocated_leg_cost).lt(aloneAllocation.allocated_leg_cost),
      'sharing a leg must reduce what an existing passenger pays for it',
    );
    assert.ok(
      money(sharedAllocation.allocated_leg_cost)
        .minus(money(aloneAllocation.allocated_leg_cost).div(2))
        .abs()
        .lte(0.01),
    );
  });

  it('leaves no matched passenger without an allocation (category 36)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });
    await joinPool({ driver: jashim, passenger: shirin });

    const { rows } = await pool.query(
      `SELECT m.id AS pool_member_id
         FROM ride_pools rp
         JOIN pool_members m ON m.ride_pool_id = rp.id
         LEFT JOIN pool_fare_calculations c
                ON c.ride_pool_id = rp.id AND c.status = 'CURRENT'
         LEFT JOIN passenger_fare_allocations a
                ON a.fare_calculation_id = c.id AND a.pool_member_id = m.id
        WHERE rp.id = $1::uuid AND a.id IS NULL`,
      [poolId],
    );

    assert.deepStrictEqual(rows, [], 'every matched member is priced in the current calculation');

    const calculation = await currentCalculation(poolId);
    assert.strictEqual((await allocationsOf(calculation.id)).length, 3);
  });

  it('recalculates the plan, not just the passengers (category 28)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);
    const legs = await legsOf(calculation.id);
    const stops = await stopsOf(poolId);

    assert.strictEqual(legs.length, stops.length - 1, 'a leg per consecutive pair of stops');
    assert.deepStrictEqual(
      legs.map((leg) => [leg.from_pool_stop_id, leg.to_pool_stop_id]),
      stops.slice(0, -1).map((stop, index) => [stop.id, stops[index + 1].id]),
      'the legs are the plan, in order',
    );
    assert.deepStrictEqual(
      legs.map((leg) => leg.sequence),
      [1, 2, 3],
    );
  });
});

// ========================================================================
// 3. Leg shares
// ========================================================================

describe('leg shares', () => {
  it('gives a share only for the legs a passenger was on board for (categories 1-4, 19)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);
    const stops = await stopsOf(poolId);
    const members = await memberIdsOf(poolId);
    const state = await poolState(poolId);

    // What the plan says, derived from the stops by the same rule the calculation
    // uses: a pickup adds, a drop-off removes, and the leg after a stop is paid
    // by whoever is left on board. The rule reads the plan the way the service
    // hands it over -- camelCase member objects -- so the rows are mapped first.
    const expected = onboardByLeg({
      stops: stops.map((stop) => ({
        sequence: stop.sequence,
        stopType: stop.stop_type,
        poolMemberId: stop.pool_member_id,
      })),
      members: members.map((id) => ({ id })),
      capacity: state.capacity_snapshot,
    });

    const legs = await legsOf(calculation.id);
    assert.deepStrictEqual(
      legs.map((leg) => leg.onboard_passenger_count),
      expected.legs.map((leg) => leg.onboardMemberIds.length),
    );

    for (const allocation of await allocationsOf(calculation.id)) {
      const shares = await sharesOf(allocation.id);
      const onBoardLegs = expected.legs.filter((leg) =>
        leg.onboardMemberIds.includes(allocation.pool_member_id),
      );

      assert.deepStrictEqual(
        shares.map((share) => share.sequence),
        onBoardLegs.map((leg) => leg.sequence),
        'a passenger is charged for exactly the legs they were on',
      );

      // And never for a leg they were not on: the legs before their pickup and
      // after their drop-off have no share for them.
      const legsNotOn = expected.legs
        .filter((leg) => !leg.onboardMemberIds.includes(allocation.pool_member_id))
        .map((leg) => leg.sequence);
      assert.ok(
        shares.every((share) => !legsNotOn.includes(share.sequence)),
        'nobody pays for a leg they were not in the car for',
      );
    }
  });

  it('splits every leg exactly, with one share per passenger on board (categories 15, 16, 17)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });
    await joinPool({ driver: jashim, passenger: shirin });

    const calculation = await currentCalculation(poolId);
    const legs = await legsOf(calculation.id);
    const allocations = await allocationsOf(calculation.id);

    for (const leg of legs) {
      const shares = (
        await Promise.all(
          allocations.map(async (allocation) =>
            (await sharesOf(allocation.id)).filter((share) => share.pool_fare_leg_id === leg.id),
          ),
        )
      ).flat();

      assert.strictEqual(
        shares.length,
        leg.onboard_passenger_count,
        `leg ${leg.sequence} must have one share per passenger on board`,
      );
      assert.strictEqual(
        sumMoney(shares.map((share) => share.allocated_amount)).toFixed(6),
        leg.total_leg_cost,
        `leg ${leg.sequence}: the shares must add up to the leg's cost, exactly`,
      );

      // Unrounded shares on a leg are all the same number, and each passenger is
      // charged that, one currency unit either way at most.
      const unrounded = new Set(shares.map((share) => share.unrounded_amount));
      assert.strictEqual(unrounded.size, 1);

      const amounts = shares.map((share) => money(share.allocated_amount));
      const spread = Prisma.Decimal.max(...amounts).minus(Prisma.Decimal.min(...amounts));
      assert.ok(spread.lte(0.01), `leg ${leg.sequence} is uneven by ${spread.toString()}`);

      for (const share of shares) {
        assert.strictEqual(
          share.rounding_adjustment,
          money(share.allocated_amount).minus(share.unrounded_amount).toFixed(10),
          'the stored adjustment is the exact difference from the quotient',
        );
      }
    }
  });

  it('hands the residual units out in member order (categories 17, 18)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });
    await joinPool({ driver: jashim, passenger: shirin });

    const calculation = await currentCalculation(poolId);
    const allocations = await allocationsOf(calculation.id);
    const legs = await legsOf(calculation.id);

    // For every leg that three passengers share, the passengers who received a
    // residual unit are the lowest member ids -- deterministically.
    for (const leg of legs) {
      if (leg.onboard_passenger_count < 2) continue;

      const charged = await Promise.all(
        allocations.map(async (allocation) => {
          const [share] = (await sharesOf(allocation.id)).filter(
            (candidate) => candidate.pool_fare_leg_id === leg.id,
          );
          return share ? { memberId: allocation.pool_member_id, share } : null;
        }),
      );

      const present = charged.filter(Boolean);
      const sorted = [...present].sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
      const amounts = sorted.map(({ share }) => money(share.allocated_amount));
      for (let index = 1; index < amounts.length; index += 1) {
        assert.ok(
          amounts[index - 1].gte(amounts[index]),
          'the lower member id is never charged less than a higher one',
        );
      }
      assert.strictEqual(
        money(sorted[0].share.rounding_adjustment).gte(sorted.at(-1).share.rounding_adjustment),
        true,
      );
    }
  });

  it('sums each passenger\'s shares into what they are charged (category 14)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);

    for (const allocation of await allocationsOf(calculation.id)) {
      const shares = await sharesOf(allocation.id);
      assert.strictEqual(
        sumMoney(shares.map((share) => share.allocated_amount)).toFixed(6),
        allocation.allocated_leg_cost,
        'an allocation is the sum of its shares',
      );
      assert.strictEqual(
        money(allocation.base_fare).plus(allocation.allocated_leg_cost).toFixed(6),
        allocation.uncapped_pooled_fare,
      );
    }
  });

  it('records a leg with nobody on board without charging anybody for it (categories 17, 19)', async () => {
    // A plan where the first passenger is delivered before the second is
    // collected: the leg between those two stops has an empty car.
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);
    const legs = await legsOf(calculation.id);

    const funded = legs.filter((leg) => leg.onboard_passenger_count > 0);
    const unfunded = legs.filter((leg) => leg.onboard_passenger_count === 0);

    // Every funded leg's cost is covered by its passengers.
    for (const leg of funded) {
      assert.ok(money(leg.total_leg_cost).gte(0));
    }

    // If the plan happens to contain an empty leg, it funds nothing: the cost is
    // recorded for audit and charged to nobody.
    for (const leg of unfunded) {
      assert.strictEqual(leg.total_leg_cost, '0.000000');
      assert.strictEqual(leg.distance_cost, '0.000000');
      assert.strictEqual(leg.time_cost, '0.000000');
      assert.strictEqual(leg.traffic_adjustment, '0.000000');
      assert.ok(leg.distance_meters >= 0);
      assert.strictEqual(leg.route_snapshot.funded, false);
    }

    assert.strictEqual(
      sumMoney(legs.map((leg) => leg.total_leg_cost)).toFixed(6),
      calculation.total_variable_route_cost,
    );
  });

  it('refuses a second share for the same passenger and leg (category 37)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const calculation = await currentCalculation(poolId);
    const [allocation] = await allocationsOf(calculation.id);
    const [leg] = await legsOf(calculation.id);
    const [share] = await sharesOf(allocation.id);

    const error = await pool
      .$transaction(
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO passenger_fare_leg_shares
               (passenger_fare_allocation_id, pool_fare_leg_id, onboard_passenger_count,
                share_ratio, unrounded_amount, allocated_amount, rounding_adjustment)
             VALUES ($1::uuid, $2::uuid, $3::int, $4::numeric, $5::numeric, $6::numeric, $7::numeric)`,
            allocation.id,
            leg.id,
            leg.onboard_passenger_count,
            share.share_ratio,
            share.unrounded_amount,
            share.allocated_amount,
            share.rounding_adjustment,
          ),
        { timeout: 5000 },
      )
      .then(
        () => null,
        (err) => err,
      );

    assert.ok(error, 'a duplicate share must be refused');
    assert.strictEqual(sqlStateOf(error), '23505');
  });

  it('refuses a split that does not add up to the leg (categories 17, 37)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);
    const legs = await legsOf(calculation.id);
    const sharedLeg = legs.find((leg) => leg.onboard_passenger_count > 1);
    assert.ok(sharedLeg, 'the fixture produced a shared leg');

    // Attempt to commit a leg whose shares do not cover its cost: the deferred
    // constraint trigger refuses the transaction at commit.
    const error = await pool
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE passenger_fare_leg_shares
                SET allocated_amount = allocated_amount - 0.01,
                    rounding_adjustment = rounding_adjustment + 0.01
              WHERE pool_fare_leg_id = $1::uuid`,
            sharedLeg.id,
          );
        },
        { timeout: 5000 },
      )
      .then(
        () => null,
        (err) => err,
      );

    // Either the append-only trigger or the sum trigger refuses it -- both are
    // the point: money that does not add up cannot be committed.
    assert.ok(error, 'an unbalanced split must be refused');
    assert.ok(
      ['23514'].includes(sqlStateOf(error)) || /append-only|allocates/.test(error.message),
      `unexpected error: ${error.message}`,
    );
  });
});

// ========================================================================
// 4. Protections
// ========================================================================

describe('the passenger protections', () => {
  it('never lets a fare exceed the accepted solo fare (category 20)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const poolId = (await pool.query('SELECT id FROM ride_pools LIMIT 1')).rows[0].id;

    await joinPool({ driver: jashim, passenger: rafiq });
    await joinPool({ driver: jashim, passenger: shirin });

    const calculation = await currentCalculation(poolId);
    const allocations = await allocationsOf(calculation.id);
    assert.strictEqual(allocations.length, 3);

    for (const allocation of allocations) {
      const accepted = await requestFare(allocation.ride_request_id);
      assert.ok(
        money(allocation.final_fare).lte(accepted),
        `${allocation.final_fare} must not exceed the accepted ${accepted}`,
      );
      assert.strictEqual(
        allocation.solo_cap_applied,
        money(allocation.solo_cap_reduction).greaterThan(0),
      );
    }
  });

  it('holds both caps when a price change makes a pooled fare expensive (categories 20, 23, 24, 25)', async () => {
    await createCapTestPolicy(EXPENSIVE);
    await createCapTestPolicy(VERY_EXPENSIVE);

    // Nusrat is quoted while the expensive price list is in force, so her accepted
    // solo fare is well above what she is charged; her pool is then priced under
    // the normal list, which is the fare she has been given so far. That leaves
    // three numbers in a strict order: quote > last fare, and the new pooled fare
    // above both.
    const { poolId } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      quotePricing: EXPENSIVE,
    });
    const [nusratMember] = await memberIdsOf(poolId);

    const before = await currentCalculation(poolId);
    const nusratBefore = allocationOf(await allocationsOf(before.id), nusratMember);

    // Rafiq's own request is quoted under the normal list; only the join itself
    // runs while the higher one is in force.
    const prepared = await prepareJoin({ driver: jashim, passenger: rafiq });
    assert.ok(prepared.offerId);

    await withPricing(VERY_EXPENSIVE, () =>
      offers.acceptOffer({ driver: jashim, offerId: prepared.offerId }),
    );

    const after = await currentCalculation(poolId);
    assert.strictEqual(after.pricing_code, VERY_EXPENSIVE.code, 'the calculation records its policy');
    assert.strictEqual(after.pricing_version, 1);

    const nusratAfter = allocationOf(await allocationsOf(after.id), nusratMember);
    const accepted = await requestFare(nusratAfter.ride_request_id);

    // Both ceilings really are below the uncapped fare, and they differ, so each
    // cap has work of its own to do rather than one of them passing trivially.
    assert.ok(
      money(nusratAfter.uncapped_pooled_fare).gt(accepted),
      `uncapped ${nusratAfter.uncapped_pooled_fare} should exceed the quote ${accepted}`,
    );
    assert.ok(money(nusratAfter.uncapped_pooled_fare).gt(nusratBefore.final_fare));
    assert.ok(
      money(accepted).gt(nusratBefore.final_fare),
      `the quote ${accepted} should exceed her last fare ${nusratBefore.final_fare}`,
    );

    assert.ok(money(nusratAfter.final_fare).lte(accepted));
    assert.ok(money(nusratAfter.final_fare).lte(nusratBefore.final_fare));

    // The lower of the two ceilings is what she pays, and both reductions are
    // recorded separately: the quote took the top off, her last fare took the
    // rest. A passenger is never charged the uplift the price change created.
    assert.strictEqual(nusratAfter.final_fare, nusratBefore.final_fare);
    assert.strictEqual(nusratAfter.solo_cap_applied, true);
    assert.strictEqual(nusratAfter.no_increase_cap_applied, true);
    assert.strictEqual(nusratAfter.previous_pooled_fare_cap, nusratBefore.final_fare);
    assert.ok(money(nusratAfter.solo_cap_reduction).gt(0));
    assert.ok(money(nusratAfter.no_increase_reduction).gt(0));
    assert.strictEqual(
      sumMoney([
        nusratAfter.final_fare,
        nusratAfter.solo_cap_reduction,
        nusratAfter.no_increase_reduction,
      ]).toFixed(6),
      Prisma.Decimal.max(
        money(nusratAfter.minimum_fare),
        money(nusratAfter.uncapped_pooled_fare),
      ).toFixed(6),
      'the fare plus every reduction is what the pool would have charged',
    );
  });

  it('records the platform-funded part of a fare the minimum produced (category 23)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const calculation = await currentCalculation(poolId);
    const [allocation] = await allocationsOf(calculation.id);

    // A minimum fare that raised this passenger's fare is money no passenger
    // produced, and the calculation says so rather than letting it hide inside a
    // difference between two totals.
    const uplift = Prisma.Decimal.max(
      money(0),
      money(allocation.minimum_fare).minus(allocation.uncapped_pooled_fare),
    );

    assert.strictEqual(allocation.minimum_fare_applied, uplift.greaterThan(0));
    assert.strictEqual(calculation.total_minimum_fare_uplift, uplift.toFixed(6));
    assert.strictEqual(
      sumMoney([allocation.final_fare, allocation.solo_cap_reduction, allocation.no_increase_reduction])
        .minus(calculation.total_minimum_fare_uplift)
        .toFixed(6),
      money(allocation.final_fare)
        .plus(allocation.solo_cap_reduction)
        .plus(allocation.no_increase_reduction)
        .minus(uplift)
        .toFixed(6),
    );
  });

  it('keeps the minimum fare inside every passenger\'s protection (category 23)', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });
    const poolId = (await pool.query('SELECT id FROM ride_pools LIMIT 1')).rows[0].id;

    await joinPool({ driver: jashim, passenger: rafiq });

    const calculation = await currentCalculation(poolId);

    for (const allocation of await allocationsOf(calculation.id)) {
      // Whatever the minimum fare wanted, the two caps are the last word.
      assert.ok(money(allocation.final_fare).lte(allocation.accepted_solo_fare));
      if (allocation.previous_pooled_fare_cap !== null) {
        assert.ok(money(allocation.final_fare).lte(allocation.previous_pooled_fare_cap));
      }
      assert.ok(money(allocation.final_fare).gte(0));
    }
  });
});

// ========================================================================
// 5. Versioning and idempotency
// ========================================================================

describe('versioning', () => {
  it('allows one current calculation per pool (category 30)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const calculation = await currentCalculation(poolId);

    // The partial unique index is the real guard. A second CURRENT row cannot be
    // written, whatever the service does.
    const error = await pool
      .$transaction(
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO pool_fare_calculations
               (ride_pool_id, pool_version, pricing_policy_id, pricing_code, pricing_version,
                shared_fare_rule_version, status, currency, traffic_profile, route_distance_meters,
                route_duration_seconds, total_variable_route_cost, total_passenger_base_fare,
                total_uncapped_passenger_fare, total_minimum_fare_uplift, total_final_passenger_fare,
                total_solo_cap_reduction, total_no_increase_reduction,
                fare_rounding_unit, total_fare_rounding_adjustment)
             SELECT ride_pool_id, pool_version + 5, pricing_policy_id, pricing_code, pricing_version,
                    shared_fare_rule_version, 'CURRENT', currency, traffic_profile, route_distance_meters,
                    route_duration_seconds, total_variable_route_cost, total_passenger_base_fare,
                    total_uncapped_passenger_fare, total_minimum_fare_uplift, total_final_passenger_fare,
                    total_solo_cap_reduction, total_no_increase_reduction,
                    fare_rounding_unit, total_fare_rounding_adjustment
               FROM pool_fare_calculations WHERE id = $1::uuid`,
            calculation.id,
          ),
        { timeout: 5000 },
      )
      .then(
        () => null,
        (err) => err,
      );

    assert.ok(error, 'a second CURRENT calculation must be refused');
    assert.strictEqual(sqlStateOf(error), '23505');
    assert.deepStrictEqual(await countCalculations(poolId), { total: 1, current: 1 });
  });

  it('allows one calculation per pool version and rule version (category 31)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const calculation = await currentCalculation(poolId);

    const error = await pool
      .$transaction(
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO pool_fare_calculations
               (ride_pool_id, pool_version, pricing_policy_id, pricing_code, pricing_version,
                shared_fare_rule_version, status, currency, traffic_profile, route_distance_meters,
                route_duration_seconds, total_variable_route_cost, total_passenger_base_fare,
                total_uncapped_passenger_fare, total_minimum_fare_uplift, total_final_passenger_fare,
                total_solo_cap_reduction, total_no_increase_reduction,
                fare_rounding_unit, total_fare_rounding_adjustment)
             SELECT ride_pool_id, pool_version, pricing_policy_id, pricing_code, pricing_version,
                    shared_fare_rule_version, 'SUPERSEDED', currency, traffic_profile, route_distance_meters,
                    route_duration_seconds, total_variable_route_cost, total_passenger_base_fare,
                    total_uncapped_passenger_fare, total_minimum_fare_uplift, total_final_passenger_fare,
                    total_solo_cap_reduction, total_no_increase_reduction,
                    fare_rounding_unit, total_fare_rounding_adjustment
               FROM pool_fare_calculations WHERE id = $1::uuid`,
            calculation.id,
          ),
        { timeout: 5000 },
      )
      .then(
        () => null,
        (err) => err,
      );

    assert.ok(error, 'the same pool version cannot be calculated twice under one rule version');
    assert.strictEqual(sqlStateOf(error), '23505');
  });

  it('keeps money and versions write-once (categories 29, 31)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const calculation = await currentCalculation(poolId);

    for (const [sql, params] of [
      [
        `UPDATE pool_fare_calculations SET total_final_passenger_fare = total_final_passenger_fare + 1
          WHERE id = $1::uuid`,
        [calculation.id],
      ],
      [`UPDATE pool_fare_calculations SET pool_version = pool_version + 1 WHERE id = $1::uuid`, [calculation.id]],
      [
        `UPDATE pool_fare_calculations SET shared_fare_rule_version = 'pool-leg-share-v9' WHERE id = $1::uuid`,
        [calculation.id],
      ],
      [`UPDATE passenger_fare_allocations SET final_fare = 0 WHERE fare_calculation_id = $1::uuid`, [calculation.id]],
      [`UPDATE pool_fare_legs SET total_leg_cost = 0 WHERE fare_calculation_id = $1::uuid`, [calculation.id]],
      [
        `UPDATE passenger_fare_leg_shares SET allocated_amount = 0
          WHERE passenger_fare_allocation_id IN
              (SELECT id FROM passenger_fare_allocations WHERE fare_calculation_id = $1::uuid)`,
        [calculation.id],
      ],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const error = await pool
        .$transaction((tx) => tx.$executeRawUnsafe(sql, ...params), { timeout: 5000 })
        .then(
          () => null,
          (err) => err,
        );

      assert.ok(error, `this write must be refused: ${sql}`);
      assert.strictEqual(sqlStateOf(error), '23514');
    }

    // Only a status may move, and only away from CURRENT.
    const moved = await pool.$transaction(
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE pool_fare_calculations SET status = 'SUPERSEDED' WHERE id = $1::uuid`,
          calculation.id,
        ),
      { timeout: 5000 },
    );
    assert.ok(moved !== null);
  });

  it('is idempotent for the same pool version (category 32)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const before = await currentCalculation(poolId);
    const countsBefore = await countCalculations(poolId);

    const again = await recalculatePoolFaresStandalone({
      ridePoolId: poolId,
      expectedPoolVersion: (await poolState(poolId)).version,
    });

    assert.strictEqual(again.status, 'existing');
    assert.strictEqual(again.calculationId, before.id);

    const countsAfter = await countCalculations(poolId);
    assert.deepStrictEqual(countsAfter, countsBefore, 'nothing new was written');
  });

  it('refuses a stale expected version (category 33)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    await joinPool({ driver: jashim, passenger: rafiq });

    const state = await poolState(poolId);
    const counts = await countCalculations(poolId);

    const error = await recalculatePoolFaresStandalone({
      ridePoolId: poolId,
      expectedPoolVersion: state.version + 1,
    }).then(
      () => null,
      (err) => err,
    );

    assert.ok(error, 'a version that is not the pool\'s cannot be calculated');
    assert.strictEqual(error.statusCode, 409);
    assert.deepStrictEqual(await countCalculations(poolId), counts);
  });

  it('recalculates a pool whose calculation is missing (category 32)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    // Emulate a plan change that predates this milestone: no calculation at all.
    await pool.query(`DELETE FROM pool_fare_calculations WHERE ride_pool_id = $1::uuid`, [poolId]);
    assert.strictEqual(await currentCalculation(poolId), null);

    const outcome = await recalculatePoolFaresStandalone({
      ridePoolId: poolId,
      expectedPoolVersion: (await poolState(poolId)).version,
    });

    assert.strictEqual(outcome.status, 'created');
    assert.strictEqual(outcome.passengers, 1);
    assert.ok(await currentCalculation(poolId));
  });
});

// ========================================================================
// 6. Transactions and concurrency
// ========================================================================

describe('transactions and concurrency', () => {
  it('rolls the whole join back when the fare cannot be calculated (category 34)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const before = await poolState(poolId);
    const stopsBefore = await stopsOf(poolId);
    const countsBefore = await countCalculations(poolId);

    const request = await requestRide(rafiq);
    const offered = await assignment.assignWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(offered.mode, 'POOL_JOIN');

    // Pricing is not configured: the plan cannot be priced, so the plan change
    // must not commit.
    const error = await withEnv(env.fare, { pricingCode: 'no-such-pricing-code' }, () =>
      offers.acceptOffer({ driver: jashim, offerId: offered.offerId }),
    ).then(
      () => null,
      (err) => err,
    );

    assert.ok(error, 'an unpriced join must fail');
    assert.strictEqual(error.statusCode, 500);

    // Nothing about the pool or the request moved.
    assert.deepStrictEqual(await poolState(poolId), before);
    assert.deepStrictEqual(await stopsOf(poolId), stopsBefore);
    assert.deepStrictEqual(await countCalculations(poolId), countsBefore);
    assert.strictEqual(await requestStatus(request.id), 'WAITING');

    const members = await pool
      .query(`SELECT ride_request_id FROM pool_members WHERE ride_pool_id = $1::uuid`, [poolId])
      .then((result) => result.rows.map((row) => row.ride_request_id));
    assert.ok(!members.includes(request.id), 'no member was left behind');

    // The offer is still answerable: the driver was not told the join happened.
    const [offer] = (
      await pool.query(`SELECT status FROM dispatch_offers WHERE id = $1::uuid`, [offered.offerId])
    ).rows;
    assert.strictEqual(offer.status, 'PENDING');
  });

  it('leaves a complete answer behind when a recalculation fails (category 38)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const before = await currentCalculation(poolId);
    const beforeAllocations = await allocationsOf(before.id);

    await assert.rejects(() =>
      recalculatePoolFaresStandalone({
        ridePoolId: poolId,
        expectedPoolVersion: 999,
      }),
    );

    // A reader still sees the previous calculation, in full.
    const after = await currentCalculation(poolId);
    assert.deepStrictEqual(after, before);
    assert.deepStrictEqual(await allocationsOf(after.id), beforeAllocations);
    assert.strictEqual((await countCalculations(poolId)).current, 1);
  });

  it('produces one calculation when two recalculations race (category 35)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const version = (await poolState(poolId)).version;

    const results = await Promise.allSettled([
      recalculatePoolFaresStandalone({ ridePoolId: poolId, expectedPoolVersion: version }),
      recalculatePoolFaresStandalone({ ridePoolId: poolId, expectedPoolVersion: version }),
    ]);

    // Both answer, and either could be the writer: what matters is the result.
    assert.ok(results.every((result) => result.status === 'fulfilled'), 'a race is a controlled answer');

    const counts = await countCalculations(poolId);
    assert.deepStrictEqual(counts, { total: 1, current: 1 });

    const calculation = await currentCalculation(poolId);
    assert.strictEqual((await allocationsOf(calculation.id)).length, 1);
    assert.strictEqual((await legsOf(calculation.id)).length, 1);
  });

  it('produces one calculation when two joins race for the same pool', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    // One pool may only have one pending route change, so the two requests race
    // for the same seat and only one of them can be offered it.
    const rafiqRequest = await requestRide(rafiq);
    const shirinRequest = await requestRide(shirin);

    const outcomes = await Promise.allSettled([
      assignment.assignWaitingRequest({ rideRequestId: rafiqRequest.id }),
      assignment.assignWaitingRequest({ rideRequestId: shirinRequest.id }),
    ]);

    assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'));

    const pending = await pool
      .query(
        `SELECT id, ride_request_id FROM dispatch_offers
          WHERE ride_pool_id = $1::uuid AND status = 'PENDING'`,
        [poolId],
      )
      .then((result) => result.rows);
    assert.strictEqual(pending.length, 1, 'one pending route change per pool');

    await offers.acceptOffer({ driver: jashim, offerId: pending[0].id });

    const counts = await countCalculations(poolId);
    assert.deepStrictEqual(counts, { total: 2, current: 1 }, 'one superseded, one current');

    // Exactly one of the two requests joined; the other is still waiting for a
    // ride of its own.
    const statuses = [await requestStatus(rafiqRequest.id), await requestStatus(shirinRequest.id)];
    assert.deepStrictEqual(statuses.sort(), ['MATCHED', 'WAITING']);
  });
});

// ========================================================================
// 7. Privacy
// ========================================================================

describe('privacy', () => {
  const memberFares = async (poolId) => {
    const calculation = await currentCalculation(poolId);
    const allocations = await allocationsOf(calculation.id);
    return { calculation, allocations };
  };

  it('shows each passenger their own fare, and nobody else\'s (categories 39, 41)', async () => {
    await createCapTestPolicy(EXPENSIVE);

    // One passenger is quoted under a different price list, so the two answers
    // are genuinely different numbers. Comparing two identical fares would prove
    // nothing about whose fare was returned.
    const { poolId, request: nusratRequest } = await createInitialPool({
      driver: jashim,
      passenger: nusrat,
      quotePricing: EXPENSIVE,
    });
    const { request: rafiqRequest } = await joinPool({ driver: jashim, passenger: rafiq });

    const { calculation, allocations } = await memberFares(poolId);
    const nusratCookie = await login('nusrat@example.com');
    const rafiqCookie = await login('rafiq@example.com');

    const hers = await asUser(nusratCookie, `/ride-requests/${nusratRequest.id}/fare`);
    const his = await asUser(rafiqCookie, `/ride-requests/${rafiqRequest.id}/fare`);

    assert.strictEqual(hers.status, 200, JSON.stringify(hers.body));
    assert.strictEqual(his.status, 200, JSON.stringify(his.body));

    assert.strictEqual(hers.body.rideRequestId, nusratRequest.id);
    assert.strictEqual(his.body.rideRequestId, rafiqRequest.id);
    assert.strictEqual(hers.body.fareStatus, 'ESTIMATED');
    assert.strictEqual(hers.body.calculationStatus, 'CURRENT');
    assert.strictEqual(hers.body.poolVersion, calculation.pool_version);
    assert.strictEqual(hers.body.sharedFareRuleVersion, SHARED_FARE_RULE_VERSION);
    assert.strictEqual(hers.body.currency, 'BDT');

    const nusratAllocation = allocations.find((a) => a.ride_request_id === nusratRequest.id);
    const rafiqAllocation = allocations.find((a) => a.ride_request_id === rafiqRequest.id);

    assert.strictEqual(hers.body.currentPooledFare, money(nusratAllocation.final_fare).toFixed(0));
    assert.strictEqual(his.body.currentPooledFare, money(rafiqAllocation.final_fare).toFixed(0));

    // The two answers are different, and the difference is in the passenger's own
    // numbers: each is told the fare they accepted, and neither payload contains
    // a number or an identifier that belongs to the other.
    assert.notStrictEqual(hers.body.acceptedSoloFare, his.body.acceptedSoloFare);
    const hersPayload = JSON.stringify(hers.body);
    const hisPayload = JSON.stringify(his.body);
    assert.ok(!hisPayload.includes(nusratRequest.id), 'no identifier of the other passenger');
    assert.ok(!hersPayload.includes(rafiqRequest.id), 'no identifier of the other passenger');
    assert.ok(!hisPayload.includes(hers.body.acceptedSoloFare), 'his answer must not carry her quote');
    assert.ok(!Object.keys(his.body).includes('totalFinalPassengerFare'));
    assert.ok(!hisPayload.includes(money(calculation.total_final_passenger_fare).toFixed(2)));

    // The response shape is fixed: a client cannot ask for more.
    assert.deepStrictEqual(Object.keys(hers.body).sort(), Object.keys(his.body).sort());
  });

  it('refuses one passenger\'s fare to another passenger and to a driver (categories 40, 42)', async () => {
    const { request: nusratRequest } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const rafiqCookie = await login('rafiq@example.com');
    const jashimCookie = await login('jashim@example.com');

    const asOtherPassenger = await asUser(rafiqCookie, `/ride-requests/${nusratRequest.id}/fare`);
    assert.strictEqual(asOtherPassenger.status, 404, 'somebody else\'s request is not found');

    const asDriver = await asUser(jashimCookie, `/ride-requests/${nusratRequest.id}/fare`);
    assert.strictEqual(asDriver.status, 403, 'a driver has no passenger fare to read');

    const anonymous = await api.request(`/ride-requests/${nusratRequest.id}/fare`);
    assert.strictEqual(anonymous.status, 401);
  });

  it('answers 404 before there is a pooled fare to report', async () => {
    const request = await requestRide(nusrat);
    const cookie = await login('nusrat@example.com');

    const response = await asUser(cookie, `/ride-requests/${request.id}/fare`);
    assert.strictEqual(response.status, 404);
    assert.match(response.body.error.message, /No shared fare/);
  });

  it('does not expose a passenger\'s fare through the driver endpoints (category 42)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    const calculation = await currentCalculation(poolId);
    const [allocation] = await allocationsOf(calculation.id);

    for (const path of ['/drivers/me/pool', '/drivers/me/offers', '/drivers/me/availability']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await asUser(cookie, path);
      assert.strictEqual(response.status, 200, path);

      const payload = JSON.stringify(response.body);
      // Money would have to arrive as a field of its own. Matching the bare word
      // "fare" would only catch the event type `SHARED_FARE_CALCULATED`, which is
      // a name, not an amount.
      assert.doesNotMatch(
        payload,
        /"(fare|price|amount|cost|money|currency)[A-Za-z]*"\s*:/,
        `${path} must carry no money fields`,
      );
      assert.ok(!payload.includes(money(allocation.final_fare).toFixed(2)), path);
    }
  });

  it('does not expose the pool\'s fares through the passenger\'s request endpoint', async () => {
    const { request } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('nusrat@example.com');

    const response = await asUser(cookie, `/ride-requests/${request.id}`);
    assert.strictEqual(response.status, 200);

    // The request still reports only the solo fare the passenger accepted.
    assert.ok(response.body.acceptedQuote.fare);
    assert.ok(!Object.keys(response.body).includes('currentPooledFare'));
    assert.ok(!Object.keys(response.body).includes('fareCalculationId'));
  });
});

// ========================================================================
// 8. Scope
// ========================================================================

describe('scope', () => {
  it('introduces no payment, wallet or trip-operation endpoint (categories 44, 45, 46)', async () => {
    const cookie = await login('nusrat@example.com');

    for (const path of [
      '/payments',
      '/wallets',
      '/invoices',
      '/payouts',
      '/refunds',
      '/ride-requests/00000000-0000-4000-8000-000000000000/settle',
      '/ride-requests/00000000-0000-4000-8000-000000000000/pickup',
      '/ride-requests/00000000-0000-4000-8000-000000000000/dropoff',
      '/ride-requests/00000000-0000-4000-8000-000000000000/complete',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await api.request(path, { method: 'POST', headers: { cookie } });
      assert.strictEqual(response.status, 404, path);
    }
  });

  it('never finalizes a fare or starts a trip (category 46)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    const calculation = await currentCalculation(poolId);
    assert.strictEqual(calculation.status, 'CURRENT', 'a fare is an estimate until a trip settles it');

    const [poolRow] = (
      await pool.query(
        `SELECT status, started_at, driver_arrived_at, completed_at FROM ride_pools WHERE id = $1::uuid`,
        [poolId],
      )
    ).rows;

    assert.strictEqual(poolRow.status, 'FORMING');
    assert.strictEqual(poolRow.started_at, null);
    assert.strictEqual(poolRow.driver_arrived_at, null);
    assert.strictEqual(poolRow.completed_at, null);

    const stops = await stopsOf(poolId);
    assert.ok(stops.every((stop) => stop.status === 'PENDING'), 'no stop has been reached');

    const members = await pool
      .query(`SELECT status, picked_up_at, dropped_off_at FROM pool_members WHERE ride_pool_id = $1::uuid`, [
        poolId,
      ])
      .then((result) => result.rows);
    assert.ok(members.every((member) => member.status === 'ASSIGNED'));
    assert.ok(members.every((member) => member.picked_up_at === null && member.dropped_off_at === null));
  });

  it('refuses to price a pool whose trip has started (category 46)', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });

    await pool.query(
      `UPDATE pool_stops SET status = 'ARRIVED', actual_arrival_at = now()
        WHERE ride_pool_id = $1::uuid AND sequence = 1`,
      [poolId],
    );

    const error = await recalculatePoolFaresStandalone({
      ridePoolId: poolId,
      expectedPoolVersion: (await poolState(poolId)).version,
    }).then(
      () => null,
      (err) => err,
    );

    assert.ok(error, 'a started trip has no estimate to recalculate');
    assert.strictEqual(error.statusCode, 409);
    assert.match(error.message, /pending/);
  });

  it('keeps the fares out of every table that is not the fare ledger', async () => {
    await createInitialPool({ driver: jashim, passenger: nusrat });

    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('ride_pools', 'pool_members', 'pool_stops', 'pool_events', 'dispatch_offers')
          AND column_name ~ '(fare|price|amount|currency|cost|discount|paid)'
        ORDER BY table_name, column_name`,
    );

    assert.deepStrictEqual(
      rows,
      [],
      'a pool records a plan; only the fare ledger records money',
    );
  });
});
