/**
 * Pool matching as data and arithmetic: which insertion positions exist, what an
 * insertion does to occupancy, what it costs everybody, and how two proposals are
 * ranked.
 *
 * Nothing here touches the database, Prisma or the router. Route legs arrive as
 * numbers (distance in metres, duration in seconds) and everything else is
 * arithmetic, which is what makes the rules unit-testable, deterministic and
 * reviewable -- and it is why the router can be memoised per evaluation without
 * this module knowing anything about it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A "PLAN" IS
 * ---------------------------------------------------------------------------
 * A plan is one way of putting a new passenger's pickup and drop-off into an
 * existing pool's stop order. The pool's plan is the *passenger-carrying* route:
 *
 *     stop 1 -> stop 2 -> ... -> stop n
 *
 * The driver's approach to stop 1 is tracked separately (`approach`), because it
 * is what the *new* passenger waits for, and because the pool's stored distance
 * and duration have always described the ride rather than the journey to reach
 * it. `arrival(stop 1) = planning instant + approach`, so an arrival time is
 * always the later of "the driver drives there from where they are" and nothing
 * else -- there is no second clock to disagree with.
 *
 * ---------------------------------------------------------------------------
 * ONE PASSENGER IS ONE MEMBER
 * ---------------------------------------------------------------------------
 * A `PoolMember` is one passenger, and a plan is accepted only if occupancy never
 * exceeds the pool's `capacitySnapshot` on *any* segment. Counting members is not
 * enough: two passengers can share a vehicle on paper and not on the road, which
 * is exactly what the segment-by-segment simulation below catches.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * No fares. Joining a pool does not change what anybody pays: every passenger
 * keeps the solo fare their own quote accepted, and this module has no money in
 * it at all -- not a discount, not a redistribution, not a total.
 */

/** Bumped when the matching rules change in a way that makes old plans stale. */
export const MATCHING_RULE_VERSION = 'pool-match.v2';

/**
 * Only a pool that is still forming can be joined. A pool whose driver is on the
 * way, arrived or driving is a commitment that a new stop cannot be inserted
 * into -- the passenger would be waiting for a car that is already elsewhere.
 */
export const ELIGIBLE_POOL_STATUSES = Object.freeze(['FORMING']);

export const STOP_TYPE = Object.freeze({
  PICKUP: 'PICKUP',
  DROPOFF: 'DROPOFF',
});

/** Candidate rejection reasons, recorded on the request's timeline. */
export const PLAN_REJECTION = Object.freeze({
  OCCUPANCY: 'OCCUPANCY',
  UNROUTABLE: 'UNROUTABLE',
  NO_INSERTION: 'NO_INSERTION',
});

/** The member key used for the passenger being matched. */
export const NEW_MEMBER_KEY = 'new';

/**
 * Simulates who is in the vehicle between every pair of stops.
 *
 * The rules the brief wants enforced, in the order they can fire:
 *
 *   * a passenger cannot be dropped off before they are picked up;
 *   * a passenger cannot be picked up twice, or dropped off twice;
 *   * occupancy can never go negative (somebody left who never got in);
 *   * occupancy can never exceed the vehicle's capacity;
 *   * a complete plan ends with everybody out of the vehicle.
 *
 * Returns the timeline as well as the verdict, because "how full does this get"
 * is the thing a driver is being asked to accept.
 */
export const simulateOccupancy = ({ stops, capacity }) => {
  let occupancy = 0;
  let peakOccupancy = 0;
  const members = new Map();
  const timeline = [];

  if (!Number.isInteger(capacity) || capacity <= 0) {
    return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'capacity_not_positive' };
  }

  for (const stop of stops) {
    const state = members.get(stop.memberKey) ?? { pickedUp: false, droppedOff: false };

    if (stop.stopType === STOP_TYPE.PICKUP) {
      if (state.droppedOff) {
        return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'pickup_after_dropoff' };
      }
      if (state.pickedUp) {
        return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'duplicate_pickup' };
      }

      state.pickedUp = true;
      occupancy += 1;
    } else if (stop.stopType === STOP_TYPE.DROPOFF) {
      if (!state.pickedUp) {
        return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'dropoff_before_pickup' };
      }
      if (state.droppedOff) {
        return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'duplicate_dropoff' };
      }

      state.droppedOff = true;
      occupancy -= 1;
    } else {
      return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'unknown_stop_type' };
    }

    if (occupancy < 0) {
      return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'negative_occupancy' };
    }

    if (occupancy > capacity) {
      return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: 'capacity_exceeded' };
    }

    peakOccupancy = Math.max(peakOccupancy, occupancy);
    members.set(stop.memberKey, state);
    timeline.push({ sequence: stop.sequence, stopType: stop.stopType, occupancyAfter: occupancy });
  }

  if (occupancy !== 0) {
    return {
      valid: false,
      reason: PLAN_REJECTION.OCCUPANCY,
      detail: 'final_occupancy_not_zero',
    };
  }

  return { valid: true, peakOccupancy, timeline };
};

/**
 * Every way of inserting a pickup and a drop-off into an existing stop order.
 *
 * With `n` existing stops the new plan has `n + 2` positions, and every pair
 * `(pickupPosition, dropoffPosition)` with `pickupPosition < dropoffPosition` is
 * a candidate. The existing stops fill whatever is left, in their current
 * relative order -- which is what keeps a pool's already-promised order intact
 * while still considering every placement around them.
 *
 * This is deliberately O(n²) *positions* rather than a hardcoded "before or after":
 * it works for a pool with one member and for a pool with four.
 */
export const insertionPositions = (existingStopCount) => {
  const positions = [];
  const last = existingStopCount + 1;

  for (let pickupPosition = 0; pickupPosition <= last; pickupPosition += 1) {
    for (let dropoffPosition = pickupPosition + 1; dropoffPosition <= last; dropoffPosition += 1) {
      positions.push({ pickupPosition, dropoffPosition });
    }
  }

  return positions;
};

/**
 * Builds the ordered stop list for one insertion.
 *
 * `existingStops` must already be in sequence order. Each entry needs
 * `{ memberKey, stopType, servicePointId, rideRequestId, poolMemberId }`; the new
 * passenger's two stops are supplied separately and are marked `isNew`.
 */
export const buildProposedStops = ({
  existingStops,
  newPickup,
  newDropoff,
  pickupPosition,
  dropoffPosition,
}) => {
  const queue = [...existingStops];
  const stops = [];

  for (let position = 0; position <= existingStops.length + 1; position += 1) {
    if (position === pickupPosition) {
      stops.push({ ...newPickup, isNew: true });
    } else if (position === dropoffPosition) {
      stops.push({ ...newDropoff, isNew: true });
    } else {
      const next = queue.shift();
      stops.push({ ...next, isNew: false });
    }
  }

  return stops.map((stop, index) => ({ ...stop, sequence: index + 1 }));
};

/**
 * The stable signature of a stop order.
 *
 * Used as the last tie-break between two otherwise identical plans, so the choice
 * between them is reproducible rather than whichever row the planner returned
 * first. It is built from ids and stop types -- never from a passenger's name.
 */
export const stopOrderSignature = (stops) =>
  stops
    .map((stop) => `${stop.stopType}:${stop.servicePointId}:${stop.memberKey}`)
    .join('|');

/**
 * Absolute planned arrivals for a proposed route.
 *
 * `planningAt` is the instant the plan is made and the driver starts driving, so
 * the first stop is reached after `approach.durationSeconds` and every later stop
 * after the legs before it. One clock, one answer -- and because the legs are
 * already-known durations, acceptance can re-anchor a stored plan to a later
 * instant without asking the router again.
 */
export const plannedArrivals = ({ stops, approachDurationSeconds, legs, planningAt }) => {
  const arrivals = [];
  let elapsed = approachDurationSeconds;

  stops.forEach((stop, index) => {
    if (index > 0) elapsed += legs[index - 1].durationSeconds;
    arrivals.push(new Date(new Date(planningAt).getTime() + elapsed * 1000));
  });

  return arrivals;
};

/**
 * Everything a proposed insertion costs, as numbers.
 *
 * `baselineDurationSeconds` per existing passenger is the solo journey their own
 * quote froze (`acceptedDurationSeconds`): the promise the pool was built on. The
 * detour is the difference between that and the ride they would now take, and the
 * ratio is how many times longer it is -- both are checked, because a 12-minute
 * detour means something different on a 4-minute trip than on a 40-minute one.
 */
export const planMetrics = ({
  stops,
  legs,
  approach,
  existingPlan,
  passengerBaselines,
  requestedAt,
  planningAt,
}) => {
  const arrivals = plannedArrivals({
    stops,
    approachDurationSeconds: approach.durationSeconds,
    legs,
    planningAt,
  });
  const arrivalAt = new Map(stops.map((stop, index) => [index, arrivals[index]]));

  const totalDistanceMeters = legs.reduce((total, leg) => total + leg.distanceMeters, 0);
  const totalDurationSeconds = legs.reduce((total, leg) => total + leg.durationSeconds, 0);

  const pickupIndex = stops.findIndex((stop) => stop.isNew && stop.stopType === STOP_TYPE.PICKUP);
  const dropoffIndex = stops.findIndex((stop) => stop.isNew && stop.stopType === STOP_TYPE.DROPOFF);

  const newPickupArrival = arrivalAt.get(pickupIndex);
  const newDropoffArrival = arrivalAt.get(dropoffIndex);

  const passengerDurations = stops
    .filter((stop) => !stop.isNew)
    .map((stop) => stop.memberKey)
    .filter((memberKey, index, all) => all.indexOf(memberKey) === index)
    .map((memberKey) => {
      const pickup = stops.findIndex(
        (stop) => stop.memberKey === memberKey && stop.stopType === STOP_TYPE.PICKUP,
      );
      const dropoff = stops.findIndex(
        (stop) => stop.memberKey === memberKey && stop.stopType === STOP_TYPE.DROPOFF,
      );

      const proposedDurationSeconds =
        (arrivalAt.get(dropoff).getTime() - arrivalAt.get(pickup).getTime()) / 1000;
      const baselineDurationSeconds = passengerBaselines.get(memberKey) ?? null;
      const detourSeconds =
        baselineDurationSeconds === null ? 0 : proposedDurationSeconds - baselineDurationSeconds;

      return {
        rideRequestId: stops[pickup].rideRequestId,
        poolMemberId: stops[pickup].poolMemberId,
        baselineDurationSeconds,
        proposedDurationSeconds,
        detourSeconds,
        detourRatio:
          baselineDurationSeconds && baselineDurationSeconds > 0
            ? proposedDurationSeconds / baselineDurationSeconds
            : null,
      };
    });

  const worstDetourSeconds = passengerDurations.reduce(
    (worst, passenger) => Math.max(worst, passenger.detourSeconds),
    0,
  );
  const worstDetourRatio = passengerDurations.reduce(
    (worst, passenger) => Math.max(worst, passenger.detourRatio ?? 0),
    0,
  );

  return {
    stops,
    legs,
    approach,
    arrivals,
    totalDistanceMeters,
    totalDurationSeconds,
    addedDistanceMeters: totalDistanceMeters - existingPlan.distanceMeters,
    addedDurationSeconds: totalDurationSeconds - existingPlan.durationSeconds,
    newPickupArrivalAt: newPickupArrival,
    newDropoffArrivalAt: newDropoffArrival,
    pickupWaitSeconds: Math.max(
      0,
      (newPickupArrival.getTime() - new Date(requestedAt).getTime()) / 1000,
    ),
    driverEtaSeconds: Math.max(
      0,
      (newPickupArrival.getTime() - new Date(planningAt).getTime()) / 1000,
    ),
    passengerDurations,
    worstDetourSeconds,
    worstDetourRatio,
    stopOrderSignature: stopOrderSignature(stops),
  };
};

/**
 * Whether a fully-measured plan is allowed.
 *
 * Two rides may share a car **if and only if**:
 *
 *   1. they start from the same service point -- enforced in the candidate query,
 *      so any plan that reaches here already satisfies it, and every member of the
 *      pool started from the same corner as the new one;
 *   2. one destination is reachable from the other -- which is exactly what "the
 *      leg between the two drop-offs routed" means. An unroutable insertion is
 *      refused by the caller before this runs, so the reachability requirement is
 *      already satisfied here too.
 *
 * That leaves occupancy: the vehicle is never over capacity on any segment.
 *
 * The waiting, added-duration and detour limits that used to live here were
 * removed on purpose, and that is a product decision rather than an oversight:
 * under the rule above a shared trip is allowed because the *shape* is right --
 * same start, destinations on one another's routes -- not because the numbers came
 * out small. What still protects a passenger's wallet is the fare: joining a pool
 * never raises what anybody pays.
 */
export const validatePlan = ({ occupancy }) => {
  if (!occupancy.valid) {
    return { valid: false, reason: PLAN_REJECTION.OCCUPANCY, detail: occupancy.detail };
  }

  return { valid: true };
};

/**
 * The deterministic score of a feasible plan.
 *
 *     score = addedPoolDurationSeconds
 *           + newPassengerPickupWaitSeconds  x pickupWaitWeight
 *           + worstExistingPassengerDetour   x detourWeight
 *
 * All three terms are seconds, so with the default weights of 1 the score reads
 * as "seconds of harm this insertion does" and the weights are a way of saying
 * whose seconds matter more -- not arbitrary multipliers. The components are kept
 * so a decision can be explained after the fact.
 */
export const scorePlan = ({ metrics, weights }) => {
  const addedPoolDurationSeconds = Math.max(0, metrics.addedDurationSeconds);
  const pickupWait = Math.max(0, metrics.pickupWaitSeconds);
  const worstDetour = Math.max(0, metrics.worstDetourSeconds);

  return {
    addedPoolDurationSeconds,
    newPassengerPickupWaitSeconds: pickupWait,
    worstExistingPassengerDetourSeconds: worstDetour,
    pickupWaitWeight: weights.pickupWaitWeight,
    detourWeight: weights.detourWeight,
    score:
      addedPoolDurationSeconds +
      pickupWait * weights.pickupWaitWeight +
      worstDetour * weights.detourWeight,
  };
};

/**
 * Plan ordering: lowest score, then the least added driving, then the shortest
 * wait, then the oldest pool, then the stable pool id, then the stop order.
 *
 * The last two keys are what make matching reproducible: two pools that are
 * genuinely equivalent are ordered by an id rather than by whichever rows a query
 * happened to return, so the same situation always produces the same offer.
 */
export const comparePlans = (a, b) => {
  if (a.score !== b.score) return a.score - b.score;
  if (a.metrics.addedDurationSeconds !== b.metrics.addedDurationSeconds) {
    return a.metrics.addedDurationSeconds - b.metrics.addedDurationSeconds;
  }
  if (a.metrics.pickupWaitSeconds !== b.metrics.pickupWaitSeconds) {
    return a.metrics.pickupWaitSeconds - b.metrics.pickupWaitSeconds;
  }

  const aCreated = new Date(a.poolCreatedAt).getTime();
  const bCreated = new Date(b.poolCreatedAt).getTime();
  if (aCreated !== bCreated) return aCreated - bCreated;

  if (a.poolId !== b.poolId) return a.poolId.localeCompare(b.poolId);

  return a.metrics.stopOrderSignature.localeCompare(b.metrics.stopOrderSignature);
};

/** The best plan of a set, or null when there is none. Does not mutate its input. */
export const bestPlan = (plans) => (plans.length === 0 ? null : [...plans].sort(comparePlans)[0]);

/**
 * Merges leg geometries into one LineString.
 *
 * Consecutive legs share their join point, so the shared coordinate is dropped --
 * otherwise the stored route would carry duplicate points at every stop, and a
 * future "draw this pool's route" would show them.
 */
export const mergeLegGeometries = (geometries) => {
  const coordinates = [];

  for (const geometry of geometries) {
    if (!geometry || !Array.isArray(geometry.coordinates)) continue;

    for (const position of geometry.coordinates) {
      const previous = coordinates[coordinates.length - 1];
      if (previous && previous[0] === position[0] && previous[1] === position[1]) continue;
      coordinates.push(position);
    }
  }

  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
};

/**
 * The proposal a driver is asked to accept, and the record of what they saw.
 *
 * It contains the whole plan -- the ordered stops, the metrics each limit was
 * checked against, the score and its components, the configuration it was judged
 * by, and the pool version it was built from -- because acceptance has to be able
 * to re-anchor the plan to a later instant and to prove which rules it passed.
 *
 * It contains no passenger identity beyond ids a driver never sees, and no money.
 * A driver client can read this and cannot submit one: acceptance takes only an
 * offer id.
 */
export const buildJoinProposalSnapshot = ({
  pool,
  rideRequestId,
  newMember: newMemberStops,
  existingStops,
  metrics,
  occupancy,
  scoring,
  limits,
  routeGeometry,
  plannedAt,
}) => ({
  ruleVersion: MATCHING_RULE_VERSION,
  poolId: pool.id,
  poolVersion: pool.version,
  rideRequestId,
  plannedAt: new Date(plannedAt).toISOString(),
  score: scoring.score,
  scoreComponents: {
    addedPoolDurationSeconds: scoring.addedPoolDurationSeconds,
    newPassengerPickupWaitSeconds: scoring.newPassengerPickupWaitSeconds,
    worstExistingPassengerDetourSeconds: scoring.worstExistingPassengerDetourSeconds,
    pickupWaitWeight: scoring.pickupWaitWeight,
    detourWeight: scoring.detourWeight,
  },
  limits,
  stops: metrics.stops.map((stop, index) => ({
    sequence: stop.sequence,
    stopType: stop.stopType,
    servicePointId: stop.servicePointId,
    // The existing stop's own id, so acceptance updates the rows that already
    // exist rather than recreating them: their history has to stay attached.
    stopId: stop.stopId ?? null,
    rideRequestId: stop.rideRequestId,
    poolMemberId: stop.poolMemberId,
    memberKey: stop.memberKey,
    isNew: stop.isNew,
    plannedArrivalAt: metrics.arrivals[index].toISOString(),
  })),
  newMember: {
    rideRequestId,
    pickupServicePointId: newMemberStops.pickupServicePointId,
    dropoffServicePointId: newMemberStops.dropoffServicePointId,
    pickupSequence: metrics.stops.find(
      (stop) => stop.isNew && stop.stopType === STOP_TYPE.PICKUP,
    ).sequence,
    dropoffSequence: metrics.stops.find(
      (stop) => stop.isNew && stop.stopType === STOP_TYPE.DROPOFF,
    ).sequence,
  },
  existingStops: existingStops.map((stop) => ({
    stopId: stop.stopId,
    sequence: stop.sequence,
    stopType: stop.stopType,
    servicePointId: stop.servicePointId,
    rideRequestId: stop.rideRequestId,
    poolMemberId: stop.poolMemberId,
  })),
  legs: metrics.legs.map((leg) => ({
    fromSequence: leg.fromSequence,
    toSequence: leg.toSequence,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
  })),
  approach: {
    fromServicePointId: metrics.approach.fromServicePointId,
    distanceMeters: metrics.approach.distanceMeters,
    durationSeconds: metrics.approach.durationSeconds,
  },
  totalDistanceMeters: metrics.totalDistanceMeters,
  totalDurationSeconds: metrics.totalDurationSeconds,
  addedDistanceMeters: metrics.addedDistanceMeters,
  addedDurationSeconds: metrics.addedDurationSeconds,
  newPassengerPickupWaitSeconds: metrics.pickupWaitSeconds,
  newPassengerDriverEtaSeconds: metrics.driverEtaSeconds,
  newPassengerPickupArrivalAt: metrics.newPickupArrivalAt.toISOString(),
  passengerDurations: metrics.passengerDurations,
  worstExistingPassengerDetourSeconds: metrics.worstDetourSeconds,
  worstExistingPassengerDetourRatio: metrics.worstDetourRatio,
  peakOccupancy: occupancy.peakOccupancy,
  occupancyTimeline: occupancy.timeline,
  stopOrderSignature: metrics.stopOrderSignature,
  routeGeometry,
});

/**
 * The version of a rule set, as a comparable string, so an old offer can be told
 * apart from one made under today's rules.
 */
export const isCurrentRuleVersion = (version) => version === MATCHING_RULE_VERSION;
