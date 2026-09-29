import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ELIGIBLE_POOL_STATUSES,
  MATCHING_RULE_VERSION,
  NEW_MEMBER_KEY,
  PLAN_REJECTION,
  STOP_TYPE,
  bestPlan,
  buildJoinProposalSnapshot,
  buildProposedStops,
  comparePlans,
  insertionPositions,
  isCurrentRuleVersion,
  mergeLegGeometries,
  planMetrics,
  plannedArrivals,
  scorePlan,
  simulateOccupancy,
  stopOrderSignature,
  validatePlan,
} from '../../src/services/matching.rules.js';

/**
 * The matching rules are the whole decision: which stop orders are legal, what
 * each one costs, which one wins. They are pure, so everything the brief asks
 * about insertion, capacity, waiting, detour, scoring and tie-breaking can be
 * pinned down here, with arithmetic a reader can check by hand, and without a
 * database, a router or a clock.
 *
 * The fixture below is the demo corridor at a scale that makes the sums easy:
 * every service point sits on a line, the driver starts 250 metres away, and
 * travel is 1 metre per second, so a distance in metres is also a duration in
 * seconds. It is not a simplification of the *rules*, only of the router.
 */

// --- Fixture ------------------------------------------------------------

// A pool with one member (A) who travels from 0 to 1000, and a new passenger
// whose journey is the same corridor.
const GRID = {
  'a-pickup': 0,
  'a-dropoff': 1000,
  'new-pickup': 0,
  'new-dropoff': 1000,
};

const APPROACH = { fromServicePointId: 'driver-point', distanceMeters: 250, durationSeconds: 250 };
const EXISTING_PLAN = { distanceMeters: 1000, durationSeconds: 1000 };
const BASELINE_SECONDS = 1000;
const PASSENGER_BASELINES = new Map([['A', BASELINE_SECONDS]]);
const CAPACITY = 3;

const LIMITS = Object.freeze({
  maxPickupWaitSeconds: 480,
  maxAddedPoolDurationSeconds: 600,
  maxExistingPassengerDetourSeconds: 600,
  maxExistingPassengerDetourRatio: 1.25,
});
const WEIGHTS = Object.freeze({ pickupWaitWeight: 1, detourWeight: 1 });

// The passenger asked 60 seconds before the plan was made, so the pick-up wait
// is the arrival time plus 60 -- the wait runs from the request, not the plan.
const REQUESTED_AT = new Date('2026-09-25T05:00:00.000Z');
const PLANNING_AT = new Date('2026-09-25T05:01:00.000Z');
const POOL_CREATED_AT = new Date('2026-09-25T04:59:00.000Z');

const stopFor = (memberKey, stopType, servicePointId, extra = {}) => ({
  memberKey,
  stopType,
  servicePointId,
  rideRequestId: `rr-${memberKey}`,
  poolMemberId: `pm-${memberKey}`,
  stopId: `stop-${memberKey}-${stopType}`,
  ...extra,
});

const POOL_STOPS = [
  stopFor('A', STOP_TYPE.PICKUP, 'a-pickup', { sequence: 1 }),
  stopFor('A', STOP_TYPE.DROPOFF, 'a-dropoff', { sequence: 2 }),
];

const NEW_PICKUP = {
  memberKey: NEW_MEMBER_KEY,
  stopType: STOP_TYPE.PICKUP,
  servicePointId: 'new-pickup',
  rideRequestId: 'rr-new',
  poolMemberId: null,
};
const NEW_DROPOFF = { ...NEW_PICKUP, stopType: STOP_TYPE.DROPOFF, servicePointId: 'new-dropoff' };

/** The pool's proposed plan for one insertion, as the service hands it over. */
const proposedStopsFor = ({ pickupPosition, dropoffPosition }) =>
  buildProposedStops({
    existingStops: POOL_STOPS,
    newPickup: NEW_PICKUP,
    newDropoff: NEW_DROPOFF,
    pickupPosition,
    dropoffPosition,
  });

const legsFor = (stops) =>
  stops.slice(0, -1).map((stop, index) => {
    const next = stops[index + 1];
    const distanceMeters = Math.abs(GRID[stop.servicePointId] - GRID[next.servicePointId]);

    return {
      fromSequence: stop.sequence,
      toSequence: next.sequence,
      distanceMeters,
      durationSeconds: distanceMeters,
    };
  });

const measureStops = (stops) =>
  planMetrics({
    stops,
    legs: legsFor(stops),
    approach: APPROACH,
    existingPlan: EXISTING_PLAN,
    passengerBaselines: PASSENGER_BASELINES,
    requestedAt: REQUESTED_AT,
    planningAt: PLANNING_AT,
  });

/** Evaluates one insertion end to end, exactly as the matching service does. */
const evaluateProposal = (positions) => {
  const stops = proposedStopsFor(positions);
  const metrics = measureStops(stops);
  const occupancy = simulateOccupancy({ stops, capacity: CAPACITY });
  const scoring = scorePlan({ metrics, weights: WEIGHTS });
  const validation = validatePlan({ occupancy });

  return { positions, stops, metrics, occupancy, scoring, validation };
};

/** A plan as the ranker sees it. */
const asCandidate = (proposal, extra = {}) => ({
  score: proposal.scoring.score,
  metrics: proposal.metrics,
  poolCreatedAt: POOL_CREATED_AT,
  poolId: 'pool-1',
  ...extra,
});

const occupancyStops = (...pairs) =>
  pairs.map(([memberKey, stopType], index) => ({ memberKey, stopType, sequence: index + 1 }));

// --- Rule-set identity --------------------------------------------------

describe('the rule set identifies itself', () => {
  it('reports its own version as current and anything else as stale', () => {
    assert.strictEqual(isCurrentRuleVersion(MATCHING_RULE_VERSION), true);
    assert.strictEqual(isCurrentRuleVersion('pool-match.v0'), false);
    assert.strictEqual(isCurrentRuleVersion(null), false);
    assert.strictEqual(isCurrentRuleVersion(undefined), false);
    assert.match(MATCHING_RULE_VERSION, /^pool-match\.v\d+$/);
  });

  it('can only be joined to a pool that is still forming (category 1)', () => {
    assert.deepStrictEqual(ELIGIBLE_POOL_STATUSES, ['FORMING']);
    assert.ok(Object.isFrozen(ELIGIBLE_POOL_STATUSES), 'the eligible set must not be mutable');
    assert.strictEqual(NEW_MEMBER_KEY, 'new');
  });
});

// --- Categories 8-14: stop insertion ------------------------------------

describe('insertionPositions', () => {
  it('offers every ordered pair of positions, with the pickup first (categories 8 and 10)', () => {
    assert.deepStrictEqual(insertionPositions(0), [{ pickupPosition: 0, dropoffPosition: 1 }]);

    const forTwo = insertionPositions(2);
    assert.deepStrictEqual(forTwo, [
      { pickupPosition: 0, dropoffPosition: 1 },
      { pickupPosition: 0, dropoffPosition: 2 },
      { pickupPosition: 0, dropoffPosition: 3 },
      { pickupPosition: 1, dropoffPosition: 2 },
      { pickupPosition: 1, dropoffPosition: 3 },
      { pickupPosition: 2, dropoffPosition: 3 },
    ]);
  });

  it('never proposes a drop-off before its own pickup', () => {
    for (const count of [0, 1, 2, 3, 4, 6]) {
      for (const { pickupPosition, dropoffPosition } of insertionPositions(count)) {
        assert.ok(
          pickupPosition < dropoffPosition,
          `pickup ${pickupPosition} must precede drop-off ${dropoffPosition}`,
        );
      }
    }
  });

  it('scales to pools bigger than two passengers (category 14)', () => {
    // (n + 2) positions, choose 2 -- so 4 existing stops give 15 candidate plans
    // rather than a hardcoded pair of "before or after".
    assert.strictEqual(insertionPositions(1).length, 3);
    assert.strictEqual(insertionPositions(2).length, 6);
    assert.strictEqual(insertionPositions(4).length, 15);
    assert.strictEqual(insertionPositions(6).length, 28);

    const pairs = insertionPositions(4).map(
      ({ pickupPosition, dropoffPosition }) => `${pickupPosition}:${dropoffPosition}`,
    );
    assert.strictEqual(new Set(pairs).size, pairs.length, 'no duplicate pairs');
  });

  it('can place a stop first, last, or between any two existing stops', () => {
    const forFour = insertionPositions(4);

    assert.ok(forFour.some(({ pickupPosition }) => pickupPosition === 0));
    assert.ok(forFour.some(({ dropoffPosition }) => dropoffPosition === 5));
    assert.ok(forFour.some(({ pickupPosition }) => pickupPosition === 2 && forFour.length === 15));
  });
});

describe('buildProposedStops', () => {
  const positions = insertionPositions(POOL_STOPS.length);

  it('places the pickup before the drop-off in every proposed plan (category 8)', () => {
    for (const position of positions) {
      const stops = proposedStopsFor(position);
      const pickup = stops.findIndex((stop) => stop.isNew && stop.stopType === STOP_TYPE.PICKUP);
      const dropoff = stops.findIndex((stop) => stop.isNew && stop.stopType === STOP_TYPE.DROPOFF);

      assert.ok(pickup >= 0 && dropoff >= 0, 'both new stops are present');
      assert.ok(pickup < dropoff, `pickup at ${pickup} must precede drop-off at ${dropoff}`);
    }
  });

  it('preserves the relative order of the existing stops (category 9)', () => {
    for (const position of positions) {
      const stops = proposedStopsFor(position);
      const existingOrder = stops
        .filter((stop) => !stop.isNew)
        .map((stop) => stop.stopId);

      assert.deepStrictEqual(
        existingOrder,
        ['stop-A-PICKUP', 'stop-A-DROPOFF'],
        `plan ${position.pickupPosition}:${position.dropoffPosition} reordered the existing stops`,
      );
    }
  });

  it('numbers the plan from one with no gaps, and keeps every identity', () => {
    for (const position of positions) {
      const stops = proposedStopsFor(position);

      assert.strictEqual(stops.length, POOL_STOPS.length + 2);
      assert.deepStrictEqual(
        stops.map((stop) => stop.sequence),
        [1, 2, 3, 4],
      );

      for (const stop of stops) {
        assert.ok(stop.servicePointId, 'every stop names a service point');
        assert.ok(stop.rideRequestId, 'every stop names the request it serves');
        assert.strictEqual(typeof stop.isNew, 'boolean');
      }

      assert.strictEqual(stops.filter((stop) => stop.isNew).length, 2);
      // The existing stops keep their own row ids: acceptance updates the rows
      // that already exist rather than recreating them.
      for (const stop of stops.filter((existing) => !existing.isNew)) {
        assert.ok(stop.stopId.startsWith('stop-A-'));
      }
    }
  });

  it('does not mutate the stops it was given', () => {
    const before = JSON.stringify(POOL_STOPS);
    proposedStopsFor({ pickupPosition: 0, dropoffPosition: 1 });

    assert.strictEqual(JSON.stringify(POOL_STOPS), before);
  });
});

describe('plannedArrivals', () => {
  it('adds the approach, then every leg, to one planning clock (category 13)', () => {
    const stops = proposedStopsFor({ pickupPosition: 0, dropoffPosition: 1 });
    const legs = legsFor(stops);
    const arrivals = plannedArrivals({
      stops,
      approachDurationSeconds: APPROACH.durationSeconds,
      legs,
      planningAt: PLANNING_AT,
    });

    assert.deepStrictEqual(
      arrivals.map((arrival) => (arrival.getTime() - PLANNING_AT.getTime()) / 1000),
      [250, 1250, 2250, 3250],
    );
  });

  it('gives the same answer for the same plan and clock, and shifts with the clock', () => {
    const stops = proposedStopsFor({ pickupPosition: 1, dropoffPosition: 3 });
    const legs = legsFor(stops);

    const once = plannedArrivals({
      stops,
      approachDurationSeconds: APPROACH.durationSeconds,
      legs,
      planningAt: PLANNING_AT,
    });
    const again = plannedArrivals({
      stops,
      approachDurationSeconds: APPROACH.durationSeconds,
      legs,
      planningAt: PLANNING_AT,
    });

    assert.deepStrictEqual(once, again);

    // Acceptance re-anchors a stored plan to a later instant, so every arrival
    // has to move by exactly the same amount.
    const later = plannedArrivals({
      stops,
      approachDurationSeconds: APPROACH.durationSeconds,
      legs,
      planningAt: new Date(PLANNING_AT.getTime() + 30_000),
    });

    later.forEach((arrival, index) => {
      assert.strictEqual(arrival.getTime() - once[index].getTime(), 30_000);
    });
  });
});

describe('planMetrics', () => {
  it('measures the whole plan, the added part, and both clocks (category 24)', () => {
    const stops = proposedStopsFor({ pickupPosition: 1, dropoffPosition: 3 });
    const metrics = measureStops(stops);

    // a-pickup, new-pickup, a-dropoff, new-dropoff -- all on the same corridor.
    assert.deepStrictEqual(
      stops.map((stop) => `${stop.sequence}:${stop.stopType}:${stop.servicePointId}`),
      [
        '1:PICKUP:a-pickup',
        '2:PICKUP:new-pickup',
        '3:DROPOFF:a-dropoff',
        '4:DROPOFF:new-dropoff',
      ],
    );

    assert.strictEqual(metrics.totalDistanceMeters, 1000);
    assert.strictEqual(metrics.totalDurationSeconds, 1000);
    assert.strictEqual(metrics.addedDistanceMeters, 0);
    assert.strictEqual(metrics.addedDurationSeconds, 0);
    // The new passenger is reached 250 seconds from now, and asked 60 seconds
    // ago: the wait runs from the request, so it is 310 seconds.
    assert.strictEqual(metrics.driverEtaSeconds, 250);
    assert.strictEqual(metrics.pickupWaitSeconds, 310);
    assert.strictEqual(
      metrics.newPickupArrivalAt.getTime() - REQUESTED_AT.getTime(),
      310 * 1000,
    );
  });

  it('reports no harm when the join costs nothing and nobody is delayed', () => {
    const metrics = measureStops(proposedStopsFor({ pickupPosition: 1, dropoffPosition: 3 }));

    assert.strictEqual(metrics.worstDetourSeconds, 0);
    assert.strictEqual(metrics.worstDetourRatio, 1);
    assert.strictEqual(metrics.passengerDurations.length, 1);
    assert.deepStrictEqual(metrics.passengerDurations[0], {
      rideRequestId: 'rr-A',
      poolMemberId: 'pm-A',
      baselineDurationSeconds: BASELINE_SECONDS,
      proposedDurationSeconds: 1000,
      detourSeconds: 0,
      detourRatio: 1,
    });
  });

  it('measures each existing passenger against their own accepted journey', () => {
    // A is put behind the new passenger: A still rides 1000 seconds, but the
    // new passenger is dropped off at 1000 before A -- so A's own ride is
    // unchanged even though the vehicle drives 2000 metres further.
    const stops = proposedStopsFor({ pickupPosition: 0, dropoffPosition: 1 });
    const metrics = measureStops(stops);

    assert.strictEqual(metrics.addedDistanceMeters, 2000);
    assert.strictEqual(metrics.addedDurationSeconds, 2000);
    assert.strictEqual(metrics.passengerDurations[0].proposedDurationSeconds, 1000);
    assert.strictEqual(metrics.passengerDurations[0].detourSeconds, 0);
  });

  it('reports the worst detour across several passengers (category 14)', () => {
    const stops = [
      stopFor('A', STOP_TYPE.PICKUP, 'a-pickup', { sequence: 1, isNew: false }),
      stopFor('B', STOP_TYPE.PICKUP, 'b-pickup', { sequence: 2, isNew: false }),
      stopFor('A', STOP_TYPE.DROPOFF, 'a-dropoff', { sequence: 3, isNew: false }),
      stopFor('B', STOP_TYPE.DROPOFF, 'b-dropoff', { sequence: 4, isNew: false }),
      { ...NEW_PICKUP, sequence: 5, isNew: true },
      { ...NEW_DROPOFF, sequence: 6, isNew: true },
    ];
    const metrics = planMetrics({
      stops,
      legs: [
        { fromSequence: 1, toSequence: 2, distanceMeters: 0, durationSeconds: 0 },
        { fromSequence: 2, toSequence: 3, distanceMeters: 1000, durationSeconds: 1000 },
        { fromSequence: 3, toSequence: 4, distanceMeters: 4000, durationSeconds: 4000 },
        { fromSequence: 4, toSequence: 5, distanceMeters: 0, durationSeconds: 0 },
        { fromSequence: 5, toSequence: 6, distanceMeters: 0, durationSeconds: 0 },
      ],
      approach: APPROACH,
      existingPlan: EXISTING_PLAN,
      passengerBaselines: new Map([
        ['A', 1000],
        ['B', 2000],
      ]),
      requestedAt: REQUESTED_AT,
      planningAt: PLANNING_AT,
    });

    const byMember = new Map(
      metrics.passengerDurations.map((passenger) => [passenger.poolMemberId, passenger]),
    );

    // A rides 250 -> 1250 as promised: no detour at all.
    assert.strictEqual(byMember.get('pm-A').proposedDurationSeconds, 1000);
    assert.strictEqual(byMember.get('pm-A').detourSeconds, 0);
    // B rides 250 -> 5250 against a 2000 second baseline.
    assert.strictEqual(byMember.get('pm-B').proposedDurationSeconds, 5000);
    assert.strictEqual(byMember.get('pm-B').detourSeconds, 3000);
    assert.strictEqual(byMember.get('pm-B').detourRatio, 2.5);

    assert.strictEqual(metrics.worstDetourSeconds, 3000);
    assert.strictEqual(metrics.worstDetourRatio, 2.5);
  });

  it('checks an absolute detour, not a ratio, when there is no baseline', () => {
    const stops = proposedStopsFor({ pickupPosition: 0, dropoffPosition: 3 });
    const metrics = planMetrics({
      stops,
      legs: legsFor(stops),
      approach: APPROACH,
      existingPlan: EXISTING_PLAN,
      passengerBaselines: new Map(),
      requestedAt: REQUESTED_AT,
      planningAt: PLANNING_AT,
    });

    assert.strictEqual(metrics.passengerDurations[0].baselineDurationSeconds, null);
    assert.strictEqual(metrics.passengerDurations[0].detourRatio, null);
    assert.strictEqual(metrics.passengerDurations[0].detourSeconds, 0);
    assert.strictEqual(metrics.worstDetourRatio, 0);
  });

  it('names the stop order with ids, never with a passenger', () => {
    const stops = proposedStopsFor({ pickupPosition: 1, dropoffPosition: 3 });
    const signature = stopOrderSignature(stops);

    assert.strictEqual(
      signature,
      'PICKUP:a-pickup:A|PICKUP:new-pickup:new|DROPOFF:a-dropoff:A|DROPOFF:new-dropoff:new',
    );
    assert.strictEqual(signature, measureStops(stops).stopOrderSignature);
  });
});

describe('mergeLegGeometries', () => {
  it('drops the join point shared by consecutive legs (category 12)', () => {
    const merged = mergeLegGeometries([
      { type: 'LineString', coordinates: [[90.4, 23.7], [90.41, 23.71]] },
      { type: 'LineString', coordinates: [[90.41, 23.71], [90.42, 23.72]] },
    ]);

    assert.deepStrictEqual(merged, {
      type: 'LineString',
      coordinates: [[90.4, 23.7], [90.41, 23.71], [90.42, 23.72]],
    });
  });

  it('refuses to call a single point a route', () => {
    assert.strictEqual(mergeLegGeometries([]), null);
    assert.strictEqual(mergeLegGeometries([{ type: 'LineString', coordinates: [[90.4, 23.7]] }]), null);
  });

  it('skips legs the router could not produce', () => {
    const merged = mergeLegGeometries([
      null,
      { type: 'LineString', coordinates: [[90.4, 23.7], [90.41, 23.71]] },
      { type: 'LineString' },
    ]);

    assert.deepStrictEqual(merged.coordinates, [[90.4, 23.7], [90.41, 23.71]]);
  });
});

// --- Categories 15-20: capacity -----------------------------------------

describe('simulateOccupancy', () => {
  it('counts one passenger per member and reports how full it gets (category 15)', () => {
    const result = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['B', STOP_TYPE.PICKUP], ['A', STOP_TYPE.DROPOFF], ['B', STOP_TYPE.DROPOFF]),
      capacity: 3,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.peakOccupancy, 2);
    assert.deepStrictEqual(result.timeline, [
      { sequence: 1, stopType: 'PICKUP', occupancyAfter: 1 },
      { sequence: 2, stopType: 'PICKUP', occupancyAfter: 2 },
      { sequence: 3, stopType: 'DROPOFF', occupancyAfter: 1 },
      { sequence: 4, stopType: 'DROPOFF', occupancyAfter: 0 },
    ]);
  });

  it('refuses to exceed capacity on any segment, not just in total (categories 15 and 16)', () => {
    const result = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['B', STOP_TYPE.PICKUP], ['A', STOP_TYPE.DROPOFF], ['B', STOP_TYPE.DROPOFF]),
      capacity: 1,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, PLAN_REJECTION.OCCUPANCY);
    assert.strictEqual(result.detail, 'capacity_exceeded');
    assert.strictEqual(result.peakOccupancy, undefined);

    // Two members in a one-seat car is exactly the count-total-members check
    // that must not be the one being made: two members, but only one at a time.
    assert.strictEqual(
      simulateOccupancy({
        stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['A', STOP_TYPE.DROPOFF], ['B', STOP_TYPE.PICKUP], ['B', STOP_TYPE.DROPOFF]),
        capacity: 1,
      }).valid,
      true,
    );
  });

  it('frees the seat at a drop-off so a later passenger can use it (categories 17 and 18)', () => {
    const result = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['A', STOP_TYPE.DROPOFF], ['B', STOP_TYPE.PICKUP], ['B', STOP_TYPE.DROPOFF]),
      capacity: 1,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.peakOccupancy, 1);
    assert.deepStrictEqual(
      result.timeline.map((entry) => entry.occupancyAfter),
      [1, 0, 1, 0],
    );
  });

  it('rejects a passenger leaving without ever having got in (category 19)', () => {
    // Occupancy can only go below zero through a drop-off that was never
    // earned, and that is the check that fires: a member who leaves before
    // their pickup is refused, so the counter is never allowed to go negative.
    const result = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['B', STOP_TYPE.DROPOFF]),
      capacity: 3,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, PLAN_REJECTION.OCCUPANCY);
    assert.strictEqual(result.detail, 'dropoff_before_pickup');
  });

  it('rejects a second pickup or a second drop-off for one passenger (category 20)', () => {
    const duplicatePickup = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['A', STOP_TYPE.PICKUP]),
      capacity: 3,
    });
    assert.strictEqual(duplicatePickup.detail, 'duplicate_pickup');

    const duplicateDropoff = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP], ['A', STOP_TYPE.DROPOFF], ['A', STOP_TYPE.DROPOFF]),
      capacity: 3,
    });
    assert.strictEqual(duplicateDropoff.detail, 'duplicate_dropoff');

    const reversed = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.DROPOFF], ['A', STOP_TYPE.PICKUP]),
      capacity: 3,
    });
    assert.strictEqual(reversed.detail, 'dropoff_before_pickup');
  });

  it('rejects a plan that does not end empty (category 11)', () => {
    const result = simulateOccupancy({
      stops: occupancyStops(['A', STOP_TYPE.PICKUP]),
      capacity: 3,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.detail, 'final_occupancy_not_zero');
  });

  it('rejects a plan it cannot interpret, and a vehicle with no room', () => {
    assert.strictEqual(
      simulateOccupancy({ stops: [{ memberKey: 'A', stopType: 'DRIVE_BY', sequence: 1 }], capacity: 3 }).detail,
      'unknown_stop_type',
    );
    assert.strictEqual(
      simulateOccupancy({ stops: [], capacity: 0 }).detail,
      'capacity_not_positive',
    );
    assert.strictEqual(
      simulateOccupancy({ stops: [], capacity: 2.5 }).detail,
      'capacity_not_positive',
    );
  });
});

// --- Categories 21-23: the v2 eligibility rule ---------------------------

/**
 * Two of the three conditions are decided before a plan is ever measured: the
 * shared starting point is a candidate-query filter, and reachability is an
 * unroutable insertion refused upstream. So all that is left for this function is
 * occupancy, and that is all it is asked about here.
 */
describe('validatePlan', () => {
  it('allows any measured plan the vehicle can hold', () => {
    assert.deepStrictEqual(
      validatePlan({ occupancy: { valid: true, peakOccupancy: 2 } }),
      { valid: true },
    );
  });

  it('refuses a plan that breaks capacity, by name, and says which way (category 16)', () => {
    assert.deepStrictEqual(
      validatePlan({
        occupancy: { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'capacity_exceeded' },
      }),
      { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'capacity_exceeded' },
    );
  });

  it('no longer consults waiting, added driving or detour at all', () => {
    // An explicit statement of the redesign. A plan whose metrics would have
    // failed every one of the old limits is allowed, because none of those limits
    // is part of eligibility any more -- the shape of the two journeys is, and a
    // plan that got this far already has the right shape.
    const result = validatePlan({
      occupancy: { valid: true, peakOccupancy: 3 },
      metrics: {
        pickupWaitSeconds: 100_000,
        addedDurationSeconds: 100_000,
        worstDetourSeconds: 100_000,
        passengerDurations: [
          { rideRequestId: 'rr-A', poolMemberId: 'pm-A', detourSeconds: 100_000, detourRatio: 99 },
        ],
      },
    });

    assert.deepStrictEqual(result, { valid: true });
  });
});

// --- Categories 24-25: scoring, ranking, snapshot ------------------------

describe('every valid insertion of the demo corridor', () => {
  /**
   * The same situation as the demo walk-through in the README: a one-member pool
   * on the Banani corridor and a new passenger whose journey is the same
   * corridor. Six plans, evaluated in full.
   */
  const proposals = insertionPositions(POOL_STOPS.length).map(evaluateProposal);

  it('evaluates all six plans and their metrics (categories 10 and 24)', () => {
    assert.strictEqual(proposals.length, 6);
    assert.deepStrictEqual(
      proposals.map((proposal) => ({
        order: proposal.stops
          .map((stop) => `${stop.sequence}:${stop.stopType === STOP_TYPE.PICKUP ? 'P' : 'D'}${stop.isNew ? '*' : ''}`)
          .join(','),
        added: proposal.metrics.addedDurationSeconds,
        wait: proposal.metrics.pickupWaitSeconds,
        peak: proposal.occupancy.peakOccupancy,
      })),
      [
        { order: '1:P*,2:D*,3:P,4:D', added: 2000, wait: 310, peak: 1 },
        { order: '1:P*,2:P,3:D*,4:D', added: 0, wait: 310, peak: 2 },
        { order: '1:P*,2:P,3:D,4:D*', added: 0, wait: 310, peak: 2 },
        { order: '1:P,2:P*,3:D*,4:D', added: 0, wait: 310, peak: 2 },
        { order: '1:P,2:P*,3:D,4:D*', added: 0, wait: 310, peak: 2 },
        { order: '1:P,2:D,3:P*,4:D*', added: 2000, wait: 2310, peak: 1 },
      ],
    );
  });

  it('rejects none of them: the rule no longer consults waiting or driving (categories 21, 22)', () => {
    // Two of these six plans drive the whole corridor twice, and one collects the
    // new passenger only after A has been delivered -- all of which the old limits
    // refused by name. Under the v2 rule the only thing that can refuse a plan is
    // occupancy, and none of these overfills a two-seat car, so all six are
    // allowed and the score is what chooses between them.
    const rejected = proposals.filter((proposal) => !proposal.validation.valid);

    assert.deepStrictEqual(rejected, []);
  });

  it('picks the cheapest plan and breaks ties deterministically (category 25)', () => {
    const feasible = proposals.filter((proposal) => proposal.validation.valid).map((p) => asCandidate(p));
    const best = bestPlan(feasible);

    // Four plans cost the same; the stable stop-order signature decides, and it
    // picks the order the demo pool actually adopts: A's journey first, with the
    // new pickup inserted before A is delivered.
    assert.strictEqual(best.score, 310);
    assert.strictEqual(
      best.metrics.stopOrderSignature,
      'PICKUP:a-pickup:A|PICKUP:new-pickup:new|DROPOFF:a-dropoff:A|DROPOFF:new-dropoff:new',
    );
    assert.strictEqual(best.metrics.passengerDurations[0].detourSeconds, 0);
    assert.deepStrictEqual(
      best.metrics.stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      ['1:PICKUP', '2:PICKUP', '3:DROPOFF', '4:DROPOFF'],
    );
  });

  it('is reproducible whichever order the plans arrive in (category 25)', () => {
    const feasible = proposals.filter((proposal) => proposal.validation.valid).map((p) => asCandidate(p));

    const forwards = bestPlan(feasible);
    const backwards = bestPlan([...feasible].reverse());

    assert.strictEqual(forwards.metrics.stopOrderSignature, backwards.metrics.stopOrderSignature);
    assert.strictEqual(forwards.score, backwards.score);
  });
});

describe('scorePlan', () => {
  const metrics = {
    addedDurationSeconds: 120,
    pickupWaitSeconds: 60,
    worstDetourSeconds: 30,
  };

  it('reads as seconds of harm with the default weights', () => {
    const scoring = scorePlan({ metrics, weights: WEIGHTS });

    assert.strictEqual(scoring.score, 120 + 60 + 30);
    assert.deepStrictEqual(scoring, {
      addedPoolDurationSeconds: 120,
      newPassengerPickupWaitSeconds: 60,
      worstExistingPassengerDetourSeconds: 30,
      pickupWaitWeight: 1,
      detourWeight: 1,
      score: 210,
    });
  });

  it('keeps the components so the choice can be explained afterwards', () => {
    const scoring = scorePlan({
      metrics,
      weights: { pickupWaitWeight: 2, detourWeight: 0.5 },
    });

    assert.strictEqual(scoring.score, 120 + 60 * 2 + 30 * 0.5);
    assert.strictEqual(scoring.pickupWaitWeight, 2);
    assert.strictEqual(scoring.detourWeight, 0.5);
  });

  it('never lets a negative term reward an insertion', () => {
    // A pool planned at rush hour and measured off-peak can appear to save time;
    // the score must not pay for that.
    const scoring = scorePlan({
      metrics: { addedDurationSeconds: -237, pickupWaitSeconds: -5, worstDetourSeconds: -10 },
      weights: WEIGHTS,
    });

    assert.strictEqual(scoring.addedPoolDurationSeconds, 0);
    assert.strictEqual(scoring.newPassengerPickupWaitSeconds, 0);
    assert.strictEqual(scoring.worstExistingPassengerDetourSeconds, 0);
    assert.strictEqual(scoring.score, 0);
  });
});

describe('comparePlans', () => {
  const base = {
    score: 200,
    metrics: { addedDurationSeconds: 100, pickupWaitSeconds: 50, stopOrderSignature: 'A' },
    poolCreatedAt: POOL_CREATED_AT,
    poolId: 'pool-1',
  };
  const withOverrides = (overrides = {}) => ({
    ...base,
    ...overrides,
    metrics: { ...base.metrics, ...(overrides.metrics ?? {}) },
  });

  it('ranks by score first', () => {
    assert.ok(comparePlans(withOverrides({ score: 100 }), base) < 0);
    assert.ok(comparePlans(base, withOverrides({ score: 100 })) > 0);
    assert.strictEqual(comparePlans(base, withOverrides()), 0);
  });

  it('then by the least added driving', () => {
    const cheaper = withOverrides({ metrics: { addedDurationSeconds: 90 } });

    assert.ok(comparePlans(cheaper, base) < 0);
  });

  it('then by the shortest wait for the new passenger', () => {
    const sooner = withOverrides({ metrics: { pickupWaitSeconds: 10 } });

    assert.ok(comparePlans(sooner, base) < 0);
  });

  it('then by the oldest pool', () => {
    const older = withOverrides({ poolCreatedAt: new Date(POOL_CREATED_AT.getTime() - 60_000) });

    assert.ok(comparePlans(older, base) < 0);
  });

  it('then by a stable pool id, so equivalent pools do not depend on row order', () => {
    const first = withOverrides({ poolId: 'pool-1' });
    const second = withOverrides({ poolId: 'pool-2' });

    assert.ok(comparePlans(first, second) < 0);
    assert.ok(comparePlans(second, first) > 0);
  });

  it('and finally by the stop order, so the answer never depends on chance', () => {
    const one = withOverrides({ metrics: { stopOrderSignature: 'PICKUP:a|PICKUP:b|DROPOFF:a' } });
    const two = withOverrides({ metrics: { stopOrderSignature: 'PICKUP:a|PICKUP:b|DROPOFF:b' } });

    assert.ok(comparePlans(one, two) < 0);
    assert.ok(comparePlans(two, one) > 0);
  });

  it('is a total order: sorting twice gives the same first plan', () => {
    const plans = [
      withOverrides({ poolId: 'pool-3' }),
      withOverrides({ score: 100 }),
      withOverrides({ metrics: { addedDurationSeconds: 50, stopOrderSignature: 'Z' } }),
      withOverrides({ poolCreatedAt: new Date(POOL_CREATED_AT.getTime() - 1) }),
    ];

    const forwards = [...plans].sort(comparePlans).map((plan) => plan.score);
    const backwards = [...plans].reverse().sort(comparePlans).map((plan) => plan.score);

    assert.deepStrictEqual(forwards, backwards);
    assert.strictEqual(bestPlan(plans).score, 100);
  });
});

describe('bestPlan', () => {
  it('answers null when no plan is feasible', () => {
    assert.strictEqual(bestPlan([]), null);
  });

  it('leaves the caller\'s list alone', () => {
    const plans = [
      { score: 2, metrics: { addedDurationSeconds: 0, pickupWaitSeconds: 0, stopOrderSignature: 'b' }, poolCreatedAt: POOL_CREATED_AT, poolId: 'p' },
      { score: 1, metrics: { addedDurationSeconds: 0, pickupWaitSeconds: 0, stopOrderSignature: 'a' }, poolCreatedAt: POOL_CREATED_AT, poolId: 'p' },
    ];
    const before = plans.map((plan) => plan.score);

    bestPlan(plans);
    assert.deepStrictEqual(plans.map((plan) => plan.score), before);
  });
});

describe('buildJoinProposalSnapshot', () => {
  const proposal = evaluateProposal({ pickupPosition: 1, dropoffPosition: 3 });
  const snapshot = buildJoinProposalSnapshot({
    pool: { id: 'pool-1', version: 7 },
    rideRequestId: 'rr-new',
    newMember: {
      pickupServicePointId: 'new-pickup',
      dropoffServicePointId: 'new-dropoff',
    },
    existingStops: POOL_STOPS,
    metrics: proposal.metrics,
    occupancy: proposal.occupancy,
    scoring: proposal.scoring,
    limits: LIMITS,
    routeGeometry: { type: 'LineString', coordinates: [[90.4, 23.7], [90.42, 23.72]] },
    plannedAt: PLANNING_AT,
  });

  it('records which pool version and which rules the plan was built from', () => {
    assert.strictEqual(snapshot.ruleVersion, MATCHING_RULE_VERSION);
    assert.strictEqual(snapshot.poolId, 'pool-1');
    assert.strictEqual(snapshot.poolVersion, 7);
    assert.strictEqual(snapshot.rideRequestId, 'rr-new');
    assert.strictEqual(snapshot.plannedAt, PLANNING_AT.toISOString());
    assert.deepStrictEqual(snapshot.limits, { ...LIMITS });
  });

  it('records the score and each component that produced it', () => {
    assert.strictEqual(snapshot.score, proposal.scoring.score);
    assert.deepStrictEqual(snapshot.scoreComponents, {
      addedPoolDurationSeconds: 0,
      newPassengerPickupWaitSeconds: 310,
      worstExistingPassengerDetourSeconds: 0,
      pickupWaitWeight: 1,
      detourWeight: 1,
    });
    assert.strictEqual(
      snapshot.scoreComponents.addedPoolDurationSeconds +
        snapshot.scoreComponents.newPassengerPickupWaitSeconds *
          snapshot.scoreComponents.pickupWaitWeight +
        snapshot.scoreComponents.worstExistingPassengerDetourSeconds *
          snapshot.scoreComponents.detourWeight,
      snapshot.score,
    );
  });

  it('records the whole ordered plan, with arrivals the driver can be shown', () => {
    assert.deepStrictEqual(
      snapshot.stops.map((stop) => ({
        sequence: stop.sequence,
        stopType: stop.stopType,
        servicePointId: stop.servicePointId,
        isNew: stop.isNew,
        stopId: stop.stopId,
      })),
      [
        { sequence: 1, stopType: 'PICKUP', servicePointId: 'a-pickup', isNew: false, stopId: 'stop-A-PICKUP' },
        { sequence: 2, stopType: 'PICKUP', servicePointId: 'new-pickup', isNew: true, stopId: null },
        { sequence: 3, stopType: 'DROPOFF', servicePointId: 'a-dropoff', isNew: false, stopId: 'stop-A-DROPOFF' },
        { sequence: 4, stopType: 'DROPOFF', servicePointId: 'new-dropoff', isNew: true, stopId: null },
      ],
    );

    snapshot.stops.forEach((stop, index) => {
      assert.strictEqual(stop.plannedArrivalAt, proposal.metrics.arrivals[index].toISOString());
    });

    assert.deepStrictEqual(snapshot.newMember, {
      rideRequestId: 'rr-new',
      pickupServicePointId: 'new-pickup',
      dropoffServicePointId: 'new-dropoff',
      pickupSequence: 2,
      dropoffSequence: 4,
    });
    assert.deepStrictEqual(
      snapshot.existingStops.map((stop) => stop.stopId),
      ['stop-A-PICKUP', 'stop-A-DROPOFF'],
    );
  });

  it('records the metrics each limit was checked against', () => {
    assert.strictEqual(snapshot.totalDistanceMeters, 1000);
    assert.strictEqual(snapshot.totalDurationSeconds, 1000);
    assert.strictEqual(snapshot.addedDistanceMeters, 0);
    assert.strictEqual(snapshot.addedDurationSeconds, 0);
    assert.strictEqual(snapshot.newPassengerPickupWaitSeconds, 310);
    assert.strictEqual(snapshot.newPassengerDriverEtaSeconds, 250);
    assert.strictEqual(snapshot.newPassengerPickupArrivalAt, proposal.metrics.newPickupArrivalAt.toISOString());
    assert.strictEqual(snapshot.worstExistingPassengerDetourSeconds, 0);
    assert.strictEqual(snapshot.worstExistingPassengerDetourRatio, 1);
    assert.deepStrictEqual(snapshot.passengerDurations, proposal.metrics.passengerDurations);
    assert.strictEqual(snapshot.peakOccupancy, 2);
    assert.deepStrictEqual(snapshot.occupancyTimeline, [
      { sequence: 1, stopType: 'PICKUP', occupancyAfter: 1 },
      { sequence: 2, stopType: 'PICKUP', occupancyAfter: 2 },
      { sequence: 3, stopType: 'DROPOFF', occupancyAfter: 1 },
      { sequence: 4, stopType: 'DROPOFF', occupancyAfter: 0 },
    ]);
    assert.strictEqual(snapshot.legs.length, 3);
    assert.deepStrictEqual(snapshot.approach, {
      fromServicePointId: 'driver-point',
      distanceMeters: 250,
      durationSeconds: 250,
    });
    assert.deepStrictEqual(snapshot.routeGeometry, {
      type: 'LineString',
      coordinates: [[90.4, 23.7], [90.42, 23.72]],
    });
    assert.strictEqual(snapshot.stopOrderSignature, proposal.metrics.stopOrderSignature);
  });

  it('carries no money and no passenger contact details', () => {
    // The snapshot is shown to a driver, so it may not leak a fare and may not
    // leak who the other passenger is.
    const serialised = JSON.stringify(snapshot);

    assert.doesNotMatch(serialised, /fare|price|amount|currency|discount|taka|bdt/i);
    assert.doesNotMatch(serialised, /name|phone|email/i);

    // The only passenger-ish fields are the documented metrics and id pairs.
    const fields = Object.keys(snapshot);
    assert.deepStrictEqual(
      fields.filter((field) => /passenger/i.test(field)).sort(),
      [
        'newPassengerDriverEtaSeconds',
        'newPassengerPickupArrivalAt',
        'newPassengerPickupWaitSeconds',
        'passengerDurations',
        'worstExistingPassengerDetourRatio',
        'worstExistingPassengerDetourSeconds',
      ],
    );
  });
});
