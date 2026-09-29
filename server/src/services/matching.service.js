import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  OFFER_STATUS,
  OFFER_TYPE,
  POOL_ACTOR_TYPE,
  POOL_EVENT_TYPE,
  POOL_STATUS,
} from './dispatch.rules.js';
import {
  bestPlan,
  buildJoinProposalSnapshot,
  buildProposedStops,
  insertionPositions,
  MATCHING_RULE_VERSION,
  mergeLegGeometries,
  NEW_MEMBER_KEY,
  planMetrics,
  PLAN_REJECTION,
  scorePlan,
  simulateOccupancy,
  STOP_TYPE,
  validatePlan,
} from './matching.rules.js';
import { appendPoolEvent } from './pool.service.js';
import { estimateRoute } from './routing.service.js';
import { appendRideEvent, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE, RIDE_REQUEST_STATUS } from './ride.status.js';

/**
 * Pool-first matching: can this waiting passenger join a ride that is already
 * forming?
 *
 * The shape of the work is always the same three steps, and they are separated on
 * purpose because each one is cheaper than the next:
 *
 *   1. **Shortlist** (`findCandidatePools`) - one PostGIS query asks which forming
 *      pools pass near the new pickup. Proximity decides who is worth simulating
 *      and nothing else.
 *   2. **Simulate** (`evaluatePool`) - for each candidate, every legal way of
 *      inserting the new pickup and drop-off is routed and measured, and the plans
 *      that break capacity, waiting or detour rules are thrown away.
 *   3. **Offer** (`createJoinOffer`) - the single best plan across all pools
 *      becomes one `ADD_PASSENGER` offer to that pool's driver.
 *
 * Nothing here books anything. A plan only becomes real when the driver accepts
 * it, in offer.service.js, and the pool's version is what proves the plan is still
 * about the pool the driver was shown.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROUTER IS MEMOISED PER EVALUATION
 * ---------------------------------------------------------------------------
 * A two-stop pool has six insertion positions and four legs each; a four-stop pool
 * has fifteen positions and six legs each. Those legs come from a handful of
 * distinct place-to-place pairs, so one memo per pool evaluation turns a quadratic
 * number of routing calls into a linear one -- without which pool-first matching
 * would be too slow to run on the request path.
 */

/**
 * Stage 1: the forming pools worth simulating, nearest to the new pickup first.
 *
 * Every filter a database can answer is here, so the candidate list is already
 * the eligible list:
 *
 *   * `FORMING` only -- a pool whose driver is on the way, arrived or driving is
 *     not something a new stop can be inserted into;
 *   * a planned route exists to compare against;
 *   * the driver's account, profile and vehicle are all still active, and the
 *     driver is still `RESERVED` for this pool;
 *   * the driver is still at a service point (that is where the approach is
 *     measured from);
 *   * the pool has room by member count -- the *real* capacity test happens per
 *     segment during simulation, because a count can be satisfied on paper while
 *     the vehicle is full on the road;
 *   * the request is not already a member of it;
 *   * no join is already pending for it (`one_pending_route_change_offer_per_pool`
 *     is the constraint; this is the filter that avoids the conflict);
 *   * every stop is still `PENDING` -- nothing has been collected yet;
 *   * this pool's driver has not already refused, or let an offer for, this
 *     request expire.
 */
const CANDIDATE_POOLS_SQL = `
  SELECT rp.id,
         rp.status,
         rp.version,
         rp.capacity_snapshot,
         rp.created_at,
         rp.driver_profile_id,
         rp.vehicle_id,
         rp.planned_distance_meters::float8 AS planned_distance_meters,
         rp.planned_duration_seconds,
         dp.current_service_point_id,
         driver_point.code AS driver_point_code,
         (SELECT count(*)::int FROM pool_members pm WHERE pm.ride_pool_id = rp.id) AS member_count,
         -- Kept so the candidate record keeps its shape. Distance-to-route is no
         -- longer a filter, so there is nothing meaningful to report here.
         0::float8 AS pickup_distance_meters,
         0::float8 AS destination_distance_meters
    FROM ride_pools rp
    JOIN driver_profiles dp ON dp.id = rp.driver_profile_id
    JOIN users du          ON du.id = dp.user_id
    JOIN vehicles v        ON v.id = rp.vehicle_id
    JOIN service_points driver_point ON driver_point.id = dp.current_service_point_id
   WHERE rp.status = 'FORMING'
     AND du.active
     AND dp.status = 'RESERVED'
     AND v.active
     AND v.seat_capacity > 0
     AND driver_point.active
     -- "The driver must be online on the starting point."
     --
     -- There are two ways to be there, and the second is the one that matters
     -- while a ride is in progress. An *available* driver standing at a corner
     -- reports that corner as their service point, so the first arm covers them.
     -- A driver already committed to a ride reports the place their previous trip
     -- ended -- current_service_point_id is where they last were, not where the
     -- car is going -- so for them the honest question is where their plan
     -- starts, and this pool's first stop is that corner by the check below.
     --
     -- Without the second arm, the console's promise -- "another passenger can
     -- still be added to the car you are driving" -- could never come true. The
     -- offer was unreachable for every driver who was actually on a ride, which
     -- is the only kind of driver it was written for.
     AND (
           dp.current_service_point_id = $1::uuid
           OR EXISTS (
                 SELECT 1
                   FROM pool_stops first_stop
                  WHERE first_stop.ride_pool_id = rp.id
                    AND first_stop.sequence = 1
                    AND first_stop.stop_type = 'PICKUP'
                    AND first_stop.service_point_id = $1::uuid
              )
         )
     AND EXISTS (SELECT 1 FROM pool_members pm WHERE pm.ride_pool_id = rp.id)
     -- And every member already aboard started from that same corner. Checked
     -- against the members' own requests rather than the pool's geometry, because
     -- the rule is about the journeys, not about where a line happens to run.
     AND NOT EXISTS (
           SELECT 1
             FROM pool_members pm
             JOIN ride_requests rr ON rr.id = pm.ride_request_id
            WHERE pm.ride_pool_id = rp.id
              AND rr.pickup_service_point_id <> $1::uuid
         )
     AND (SELECT count(*)::int FROM pool_members pm WHERE pm.ride_pool_id = rp.id)
         < rp.capacity_snapshot
     AND NOT EXISTS (
           SELECT 1 FROM pool_members mine WHERE mine.ride_request_id = $2::uuid
         )
     AND NOT EXISTS (
           SELECT 1 FROM dispatch_offers pending
            WHERE pending.ride_pool_id = rp.id
              AND pending.status = 'PENDING'
              AND pending.offer_type = 'ADD_PASSENGER'
         )
     AND NOT EXISTS (
           SELECT 1 FROM pool_stops ps
            WHERE ps.ride_pool_id = rp.id AND ps.status <> 'PENDING'
         )
     AND NOT EXISTS (
           SELECT 1 FROM dispatch_offers spent
            WHERE spent.ride_request_id = $2::uuid
              AND spent.driver_profile_id = rp.driver_profile_id
              AND spent.offer_type = 'ADD_PASSENGER'
              AND spent.status IN ('REJECTED', 'EXPIRED')
         )
   ORDER BY rp.created_at ASC, rp.id ASC
   LIMIT $3::int`;

export const findCandidatePools = async ({
  pickupServicePointId,
  // Accepted and deliberately unused: the destination no longer shortlists pools.
  // Reachability between the two drop-offs is decided per insertion, by the router.
  dropoffServicePointId,
  rideRequestId,
  limit = env.matching.maxCandidatePools,
}) =>
  prisma.$queryRawUnsafe(CANDIDATE_POOLS_SQL, pickupServicePointId, rideRequestId, limit);

/**
 * A memoised leg lookup.
 *
 * `null` is cached too, so a place-to-place pair the router cannot connect is
 * asked about once rather than once per insertion position.
 */
const legRouter = ({ departureAt }) => {
  const memo = new Map();

  return async (fromCode, toCode) => {
    if (fromCode === toCode) {
      return { distanceMeters: 0, durationSeconds: 0, geometry: null };
    }

    const key = `${fromCode}->${toCode}`;
    if (memo.has(key)) return memo.get(key);

    let leg = null;

    try {
      const route = await estimateRoute({
        originServicePointCode: fromCode,
        destinationServicePointCode: toCode,
        departureAt,
      });

      leg = {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        geometry: route.geometry,
      };
    } catch (err) {
      // "No path between these two places" is a property of this pair, so the
      // plan using it is infeasible. A routing *failure* is not, and propagates.
      if (!(err instanceof ApiError && [400, 409, 422].includes(err.statusCode))) throw err;
    }

    memo.set(key, leg);
    return leg;
  };
};

/**
 * The total distance and duration of a stop order, or null when any leg of it
 * cannot be routed at all.
 *
 * Used for the baseline a proposal is measured against, so both sides of the
 * comparison come from the same router at the same instant.
 */
const measurePlan = async ({ stops, pointCodes, route }) => {
  let distanceMeters = 0;
  let durationSeconds = 0;

  for (let index = 0; index < stops.length - 1; index += 1) {
    const leg = await route(
      pointCodes.get(stops[index].servicePointId),
      pointCodes.get(stops[index + 1].servicePointId),
    );

    if (!leg) return null;

    distanceMeters += leg.distanceMeters;
    durationSeconds += leg.durationSeconds;
  }

  return { distanceMeters, durationSeconds };
};

/**
 * Stage 2: every legal insertion into one pool, measured and ranked.
 *
 * Returns the best feasible plan for this pool, or null with the reasons the
 * alternatives were refused -- which is what lets the request's timeline say why
 * a pool was passed over instead of only that it was.
 */
export const evaluatePool = async ({ candidate, request, poolStops, baselines, pointCodes, now }) => {
  const existingStops = poolStops.map((stop) => ({
    stopId: stop.id,
    memberKey: stop.poolMemberId,
    stopType: stop.stopType,
    servicePointId: stop.servicePointId,
    rideRequestId: stop.rideRequestId,
    poolMemberId: stop.poolMemberId,
  }));

  const positions = insertionPositions(existingStops.length);
  const route = legRouter({ departureAt: now });

  // What the pool would drive if it were left alone, measured *now* so the
  // comparison is like for like. Using the pool's stored duration instead would
  // mix two departure instants: the stored plan was priced when the pool was
  // created, and a quote taken inside the morning peak would make every later
  // join look like it saved time.
  const currentPlan = await measurePlan({ stops: existingStops, pointCodes, route });

  const baseline = currentPlan ?? {
    distanceMeters: candidate.planned_distance_meters,
    durationSeconds: candidate.planned_duration_seconds,
  };

  const rejections = {};
  const feasible = [];
  let routedPairs = 0;

  for (const { pickupPosition, dropoffPosition } of positions) {
    const stops = buildProposedStops({
      existingStops,
      newPickup: {
        memberKey: NEW_MEMBER_KEY,
        stopType: STOP_TYPE.PICKUP,
        servicePointId: request.pickupServicePointId,
        rideRequestId: request.id,
        poolMemberId: null,
      },
      newDropoff: {
        memberKey: NEW_MEMBER_KEY,
        stopType: STOP_TYPE.DROPOFF,
        servicePointId: request.dropoffServicePointId,
        rideRequestId: request.id,
        poolMemberId: null,
      },
      pickupPosition,
      dropoffPosition,
    });

    // The approach is part of *this* plan because it depends on which stop ends up
    // first: the driver has to reach it from where they are.
    const approachLeg = await route(candidate.driver_point_code, pointCodes.get(stops[0].servicePointId));

    if (!approachLeg) {
      rejections[PLAN_REJECTION.UNROUTABLE] = (rejections[PLAN_REJECTION.UNROUTABLE] ?? 0) + 1;
      continue;
    }

    const legs = [];
    let unroutable = false;

    for (let index = 0; index < stops.length - 1; index += 1) {
      const leg = await route(
        pointCodes.get(stops[index].servicePointId),
        pointCodes.get(stops[index + 1].servicePointId),
      );

      if (!leg) {
        unroutable = true;
        break;
      }

      legs.push({
        fromSequence: stops[index].sequence,
        toSequence: stops[index + 1].sequence,
        distanceMeters: leg.distanceMeters,
        durationSeconds: leg.durationSeconds,
        geometry: leg.geometry,
      });
    }

    if (unroutable) {
      rejections[PLAN_REJECTION.UNROUTABLE] = (rejections[PLAN_REJECTION.UNROUTABLE] ?? 0) + 1;
      continue;
    }

    routedPairs += 1;

    const occupancy = simulateOccupancy({ stops, capacity: candidate.capacity_snapshot });

    const metrics = planMetrics({
      stops,
      legs,
      approach: {
        fromServicePointId: candidate.current_service_point_id,
        distanceMeters: approachLeg.distanceMeters,
        durationSeconds: approachLeg.durationSeconds,
      },
      existingPlan: baseline,
      passengerBaselines: baselines,
      requestedAt: request.requestedAt,
      planningAt: now,
    });

    const verdict = validatePlan({ occupancy });

    if (!verdict.valid) {
      const key = verdict.detail ? `${verdict.reason}:${verdict.detail}` : verdict.reason;
      rejections[key] = (rejections[key] ?? 0) + 1;
      continue;
    }

    feasible.push({
      poolId: candidate.id,
      poolVersion: candidate.version,
      poolCreatedAt: candidate.created_at,
      metrics,
      occupancy,
      legs,
      scoring: scorePlan({ metrics, weights: env.matching }),
      score: 0,
    });
  }

  if (feasible.length === 0) {
    return { plan: null, evaluated: positions.length, routedPairs, rejections };
  }

  for (const plan of feasible) plan.score = plan.scoring.score;
  return {
    plan: bestPlan(feasible),
    evaluated: positions.length,
    routedPairs,
    feasible: feasible.length,
    rejections,
  };
};

/**
 * Evaluates every shortlisted pool and returns the best plan across all of them.
 *
 * The database is not touched here beyond reads: this is the expensive stage, and
 * it happens before any transaction is opened so a slow search never holds a row
 * lock.
 */
export const findBestJoinPlan = async ({ request, now, radiusMeters }) => {
  const candidates = await findCandidatePools({
    pickupServicePointId: request.pickupServicePointId,
    dropoffServicePointId: request.dropoffServicePointId,
    rideRequestId: request.id,
    radiusMeters,
  });

  if (candidates.length === 0) {
    return { plan: null, candidates: [], evaluated: 0, rejections: {} };
  }

  const poolIds = candidates.map((candidate) => candidate.id);

  const [stops, members] = await Promise.all([
    prisma.poolStop.findMany({
      where: { ridePoolId: { in: poolIds } },
      orderBy: [{ ridePoolId: 'asc' }, { sequence: 'asc' }],
      select: {
        id: true,
        ridePoolId: true,
        sequence: true,
        stopType: true,
        servicePointId: true,
        rideRequestId: true,
        poolMemberId: true,
      },
    }),
    prisma.poolMember.findMany({
      where: { ridePoolId: { in: poolIds } },
      select: {
        id: true,
        ridePoolId: true,
        rideRequest: { select: { id: true, acceptedDurationSeconds: true } },
      },
    }),
  ]);

  // The codes are what the router takes, so only the places this evaluation can
  // possibly mention are loaded: the trip itself, every stop in the shortlist, and
  // every candidate driver's current point.
  const pointIds = new Set([
    request.pickupServicePointId,
    request.dropoffServicePointId,
    ...stops.map((stop) => stop.servicePointId),
    ...candidates.map((candidate) => candidate.current_service_point_id),
  ]);

  const points = await prisma.servicePoint.findMany({
    where: { id: { in: [...pointIds] } },
    select: { id: true, code: true },
  });

  const pointCodes = new Map(points.map((point) => [point.id, point.code]));

  // Each member's baseline is the solo journey their own quote froze: the promise
  // the pool was built on, and what a detour is measured against.
  const baselinesByPool = new Map();
  for (const member of members) {
    const baselines = baselinesByPool.get(member.ridePoolId) ?? new Map();
    baselines.set(member.id, member.rideRequest.acceptedDurationSeconds);
    baselinesByPool.set(member.ridePoolId, baselines);
  }

  const stopsByPool = new Map();
  for (const stop of stops) {
    const list = stopsByPool.get(stop.ridePoolId) ?? [];
    list.push(stop);
    stopsByPool.set(stop.ridePoolId, list);
  }

  const rejections = {};
  const plans = [];
  let evaluated = 0;

  for (const candidate of candidates) {
    const poolStops = stopsByPool.get(candidate.id) ?? [];
    if (poolStops.length === 0) continue;

    const outcome = await evaluatePool({
      candidate,
      request,
      poolStops,
      baselines: baselinesByPool.get(candidate.id) ?? new Map(),
      pointCodes,
      now,
    });

    evaluated += outcome.evaluated;

    for (const [reason, count] of Object.entries(outcome.rejections)) {
      rejections[reason] = (rejections[reason] ?? 0) + count;
    }

    if (outcome.plan) plans.push({ ...outcome.plan, candidate });
  }

  return {
    plan: bestPlan(plans),
    candidates: candidates.map((candidate) => ({
      poolId: candidate.id,
      version: candidate.version,
      pickupDistanceMeters: Math.round(candidate.pickup_distance_meters),
      destinationDistanceMeters: Math.round(candidate.destination_distance_meters),
      memberCount: candidate.member_count,
      capacity: candidate.capacity_snapshot,
    })),
    evaluated,
    rejections,
  };
};

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.matching.transactionTimeoutMs });

/**
 * Stage 3: turns the best plan into one `ADD_PASSENGER` offer.
 *
 * Everything the evaluation saw is re-read under locks, because the search
 * happened outside any transaction: the pool may have been joined, cancelled or
 * changed while the router was working. The offer records the pool version it was
 * planned against, which is the promise acceptance later relies on -- if the pool
 * moves on, this offer can no longer be accepted.
 *
 * The proposal the driver is shown is the snapshot stored here. A driver client
 * can read it and cannot submit one.
 */
export const createJoinOffer = async ({ request, plan, now = new Date() }) => {
  const candidate = plan.candidate;

  try {
    return await createJoinOfferInTransaction({ request, plan, candidate, now });
  } catch (err) {
    // Two orchestrators racing for the same pool both read "no offer yet" before
    // either wrote one, so one of them loses on a partial unique index -- one
    // pending offer per request, per driver, per pool. That is the constraint
    // doing its job, not a failure: the loser is told the same thing the loser of
    // a *sequential* race is told, and the orchestrator moves on to the next
    // option. Without this, the losing call would surface a unique violation to
    // whoever asked for the assignment.
    if (err?.code === 'P2002') {
      return { offered: false, reason: 'offer_conflict' };
    }

    throw err;
  }
};

const createJoinOfferInTransaction = ({ request, plan, candidate, now }) =>
  inTransaction(async (tx) => {
    // The request first, then the pool: the same order every other path uses.
    const lockedRequest = await lockRideRequest(tx, request.id);

    if (!lockedRequest || lockedRequest.status !== RIDE_REQUEST_STATUS.WAITING) {
      return { offered: false, reason: 'request_not_waiting' };
    }

    if (lockedRequest.searchExpiresAt.getTime() <= now.getTime()) {
      return { offered: false, reason: 'search_window_closed' };
    }

    const existingMember = await tx.poolMember.findUnique({
      where: { rideRequestId: request.id },
      select: { id: true },
    });
    if (existingMember) return { offered: false, reason: 'already_in_pool' };

    const openOffer = await tx.dispatchOffer.findFirst({
      where: { rideRequestId: request.id, status: OFFER_STATUS.PENDING },
      select: { id: true },
    });
    if (openOffer) return { offered: false, reason: 'already_offered', offerId: openOffer.id };

    await tx.$queryRawUnsafe(`SELECT id FROM ride_pools WHERE id = $1::uuid FOR UPDATE`, candidate.id);

    const pool = await tx.ridePool.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        status: true,
        version: true,
        capacitySnapshot: true,
        driverProfileId: true,
        vehicleId: true,
        plannedDistanceMeters: true,
        plannedDurationSeconds: true,
      },
    });

    if (!pool || pool.status !== POOL_STATUS.FORMING) {
      return { offered: false, reason: 'pool_not_forming' };
    }

    if (pool.version !== plan.poolVersion) {
      // The plan describes a stop order the pool has already moved on from.
      return { offered: false, reason: 'pool_version_changed' };
    }

    const routingOffer = await tx.dispatchOffer.findFirst({
      where: {
        ridePoolId: pool.id,
        status: OFFER_STATUS.PENDING,
        offerType: OFFER_TYPE.ADD_PASSENGER,
      },
      select: { id: true },
    });
    if (routingOffer) return { offered: false, reason: 'pool_already_offered' };

    const memberCount = await tx.poolMember.count({ where: { ridePoolId: pool.id } });
    if (memberCount >= pool.capacitySnapshot) {
      return { offered: false, reason: 'pool_full' };
    }

    const vehicle = await tx.vehicle.findUnique({
      where: { id: pool.vehicleId },
      select: { id: true, name: true, seatCapacity: true, active: true },
    });
    if (!vehicle || !vehicle.active) {
      return { offered: false, reason: 'vehicle_unavailable' };
    }

    const driver = await tx.driverProfile.findUnique({
      where: { id: pool.driverProfileId },
      select: { id: true, status: true, currentServicePointId: true },
    });
    if (!driver || driver.status !== 'RESERVED') {
      return { offered: false, reason: 'driver_not_assigned' };
    }

    const routeGeometry = mergeLegGeometries(plan.legs.map((leg) => leg.geometry));

    const snapshot = buildJoinProposalSnapshot({
      pool,
      rideRequestId: request.id,
      newMember: {
        pickupServicePointId: request.pickupServicePointId,
        dropoffServicePointId: request.dropoffServicePointId,
      },
      existingStops: plan.metrics.stops
        .filter((stop) => !stop.isNew)
        .map((stop) => ({ ...stop })),
      metrics: plan.metrics,
      occupancy: plan.occupancy,
      scoring: plan.scoring,
      limits: {
        ruleVersion: MATCHING_RULE_VERSION,
        windowSeconds: env.matching.windowSeconds,
        radiusMeters: env.matching.radiusMeters,
        maxPickupWaitSeconds: env.matching.maxPickupWaitSeconds,
        maxAddedPoolDurationSeconds: env.matching.maxAddedPoolDurationSeconds,
        maxExistingPassengerDetourSeconds: env.matching.maxExistingPassengerDetourSeconds,
        maxExistingPassengerDetourRatio: env.matching.maxExistingPassengerDetourRatio,
        pickupWaitWeight: env.matching.pickupWaitWeight,
        detourWeight: env.matching.detourWeight,
      },
      routeGeometry,
      plannedAt: now,
    });

    const expiresAt = new Date(now.getTime() + env.dispatch.offerTtlSeconds * 1000);

    const offer = await tx.dispatchOffer.create({
      data: {
        rideRequestId: request.id,
        driverProfileId: pool.driverProfileId,
        vehicleId: pool.vehicleId,
        ridePoolId: pool.id,
        poolVersion: pool.version,
        offerType: OFFER_TYPE.ADD_PASSENGER,
        status: OFFER_STATUS.PENDING,
        // For a join, "how the driver reaches the new passenger" is the whole
        // point of the offer, so the approach columns describe exactly that.
        approachDistanceMeters: snapshot.approach.distanceMeters,
        approachDurationSeconds: snapshot.approach.durationSeconds,
        score: snapshot.score,
        offeredAt: now,
        expiresAt,
        proposalSnapshot: snapshot,
      },
      select: { id: true, expiresAt: true },
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.JOIN_PLAN_CREATED,
      actorType: POOL_ACTOR_TYPE.SYSTEM,
      metadata: {
        offerId: offer.id,
        rideRequestId: request.id,
        ruleVersion: MATCHING_RULE_VERSION,
        poolVersion: pool.version,
        score: snapshot.score,
        addedDistanceMeters: snapshot.addedDistanceMeters,
        addedDurationSeconds: snapshot.addedDurationSeconds,
        pickupWaitSeconds: snapshot.newPassengerPickupWaitSeconds,
        worstDetourSeconds: snapshot.worstExistingPassengerDetourSeconds,
        occupancyBefore: memberCount,
        occupancyAfter: memberCount + 1,
        capacity: pool.capacitySnapshot,
      },
      now,
    });

    await appendRideEvent(tx, {
      rideRequestId: request.id,
      eventType: RIDE_EVENT_TYPE.POOL_JOIN_OFFERED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      previousStatus: RIDE_REQUEST_STATUS.WAITING,
      newStatus: RIDE_REQUEST_STATUS.WAITING,
      metadata: {
        offerId: offer.id,
        ridePoolId: pool.id,
        poolVersion: pool.version,
        ruleVersion: MATCHING_RULE_VERSION,
        score: snapshot.score,
        addedDistanceMeters: snapshot.addedDistanceMeters,
        addedDurationSeconds: snapshot.addedDurationSeconds,
        pickupWaitSeconds: snapshot.newPassengerPickupWaitSeconds,
        worstDetourSeconds: snapshot.worstExistingPassengerDetourSeconds,
        stopOrder: snapshot.stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      },
      now,
    });

    return {
      offered: true,
      offerId: offer.id,
      ridePoolId: pool.id,
      poolVersion: pool.version,
      driverProfileId: pool.driverProfileId,
      expiresAt: offer.expiresAt.toISOString(),
      score: snapshot.score,
    };
  });

