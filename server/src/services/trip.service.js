import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  DRIVER_AVAILABILITY,
  OFFER_STATUS,
  OFFER_TYPE,
  POOL_ACTOR_TYPE,
  POOL_EVENT_TYPE,
  POOL_MEMBER_STATUS,
  POOL_STATUS,
  POOL_STOP_STATUS,
  POOL_STOP_TYPE,
} from './dispatch.rules.js';
import { requireDriverProfileId } from './driver.service.js';
import { createPaymentsForPool } from './payment.service.js';
import { finalizePoolFareCalculation } from './pool-fare.service.js';
import { appendPoolEvent, lockPool, lockPoolStops } from './pool.service.js';
import {
  appendRideEvent,
  applyRideRequestTransition,
  lockRideRequest,
} from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE, RIDE_REQUEST_STATUS } from './ride.status.js';
import {
  TRIP_DECISION,
  canChangePoolStatus,
  decideArrival,
  decideCompletion,
  decideDepart,
  decideDropoff,
  decidePickup,
  decideStart,
  finalDropoffStop,
  firstPickupStop,
  onboardMemberIds,
} from './trip.rules.js';

/**
 * The driver-operated trip: depart, arrive, collect, start, deliver, complete.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE SIX OPERATIONS ARE
 * ---------------------------------------------------------------------------
 * A pool is a commitment between a driver and the passengers in it. Dispatch and
 * matching decide *who* is in it; these six operations are what the driver then
 * does with it, and each one records a fact that already happened:
 *
 *     depart      the driver set off for the first pickup
 *     arrive      the driver reached a stop
 *     pickup      a passenger got in
 *     start       the journey began with the passengers on board
 *     dropoff     a passenger was delivered
 *     complete    the pool is over and the driver is free again
 *
 * The decisions live in trip.rules.js, which is pure: this file is what locks the
 * rows, asks the rules, and writes the answer down. Nothing here decides whether
 * an operation is allowed -- if a rule and this file ever disagree, this file is
 * wrong, and the tests for the rules are the ones that say so.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY: A RETRY IS NOT A SECOND TRIP
 * ---------------------------------------------------------------------------
 * Every command is safe to send twice. The retry is recognised by *state*, not by
 * an idempotency key: the resources it names (this pool, this stop, this member)
 * are already in the state the command produces, so the rules answer REPEAT, no
 * timestamp moves, no event is written, and the caller gets the current state
 * back with a 200. An operation that has *not* succeeded is never mistaken for
 * one that has: a stop that the driver has not reached is a 409, not a repeat.
 *
 * An idempotency key would not help here and would add a second, competing idea
 * of "the same request". `POST /ride-requests` needs one because it creates a row
 * whose identity the caller chooses; these commands change rows that are already
 * named by the URL.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDER
 * ---------------------------------------------------------------------------
 * Two locks are always taken by every operation, in this order:
 *
 *     the pool, then its stops, then its members' ride requests, then the driver
 *
 * Taking them in one order is what makes two operations on the same pool
 * serialise rather than deadlock: whoever holds the pool decides, and the other
 * one waits and then sees the result. The pool is also what makes every check
 * meaningful -- the status, the stop order and the occupancy are all read under
 * its lock, so a concurrent command cannot slip between a check and the write.
 *
 * Departure adds one step *in front* of that order, and it needs explaining. A
 * departure has to cancel the join offers the pool still has pending, and a
 * cancelled offer belongs on the offered passenger's own timeline -- which means
 * locking that passenger's request. The acceptance of a join offer locks *its*
 * request first and the pool second, so a departure that held the pool and then
 * asked for that request could deadlock with it. The fix is to take those
 * requests *first*, in ascending id order, and only then the pool: the same
 * request-before-pool order the acceptance already uses, so the two can only
 * serialise. Nothing else in the project holds a member request and then waits
 * for a pool, so no cycle exists -- and the departure, holding the pool, is the
 * only place this milestone takes a lock before it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * No payment, no settlement, no cancellation by either side, no no-show, no
 * live position, no notification, no rating, and no rematching: a departed pool
 * is closed to matching, and a completed one does not start another.
 */

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.trip.transactionTimeoutMs });

/**
 * The passenger's own trip, for their current-ride response.
 *
 * Everything here belongs to the caller's ride request: their member row, their
 * two stops, the pool they are in (for its status and the driver), and their own
 * timeline. No other member, stop or request is read, which is what makes "a
 * passenger sees only their own ride" structural rather than a filter: there is
 * nothing else in the result to leave out.
 *
 * Returns null for a request that has not been matched: there is no trip yet, and
 * a client should be told that rather than shown an empty one.
 */
export const loadPassengerTrip = async (rideRequestId) => {
  const member = await prisma.poolMember.findUnique({
    where: { rideRequestId },
    select: {
      id: true,
      status: true,
      matchedAt: true,
      pickedUpAt: true,
      droppedOffAt: true,
      ridePoolId: true,
      ridePool: {
        select: {
          id: true,
          status: true,
          departedAt: true,
          driverArrivedAt: true,
          startedAt: true,
          completedAt: true,
          vehicle: { select: { name: true, seatCapacity: true } },
          driverProfile: { select: { user: { select: { name: true } } } },
        },
      },
      stops: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          stopType: true,
          status: true,
          plannedArrivalAt: true,
          actualArrivalAt: true,
          completedAt: true,
          servicePoint: { select: { code: true, name: true } },
        },
      },
    },
  });

  if (!member) return null;

  const events = await prisma.rideEvent.findMany({
    where: { rideRequestId },
    orderBy: { sequence: 'asc' },
    select: { sequence: true, eventType: true, actorType: true, createdAt: true },
  });

  return { member, pool: member.ridePool, stops: member.stops, events };
};

/**
 * A pool a driver may not drive is *not found*, never "forbidden".
 *
 * The same answer the offer endpoints give for another driver's offer: a 403
 * would confirm that the id exists, which is a way of listing other drivers'
 * work. This is the only authorization check the trip needs, because the driver
 * comes from the session and is never named in a body or a query.
 */
const poolNotFound = (ridePoolId) =>
  new ApiError(404, `Ride pool "${ridePoolId}" was not found`);

const stopNotFound = (stopId) =>
  new ApiError(404, `Stop "${stopId}" was not found in this pool`);

const memberNotFound = (memberId) =>
  new ApiError(404, `Passenger "${memberId}" was not found in this pool`);

/** Locks one driver profile, the last lock every operation takes. */
const lockDriver = async (tx, driverProfileId) => {
  await tx.$queryRawUnsafe(
    `SELECT id FROM driver_profiles WHERE id = $1::uuid FOR UPDATE`,
    driverProfileId,
  );

  return tx.driverProfile.findUnique({
    where: { id: driverProfileId },
    select: { id: true, status: true, currentServicePointId: true, availableSince: true },
  });
};

/**
 * Locks every member's ride request, in ascending id order.
 *
 * The order is not cosmetic: two transactions that lock the same set in
 * different orders can deadlock, and a member's request is locked here, by the
 * fare service and by nothing else -- so all of them agree on the order.
 */
const lockMemberRequests = async (tx, members) => {
  const requestIds = [...new Set(members.map((member) => member.rideRequestId))].sort();

  const requests = new Map();
  for (const requestId of requestIds) {
    // eslint-disable-next-line no-await-in-loop
    const request = await lockRideRequest(tx, requestId);
    if (!request) {
      throw new ApiError(500, `A pool member names ride request ${requestId}, which was not found`);
    }
    requests.set(requestId, request);
  }

  return requests;
};

/**
 * Everything the trip's decisions read, locked.
 *
 * The members are handed to the rules with the status of the request they belong
 * to attached (`requestStatus`), because "may this passenger be collected" is a
 * question about the ride as well as about the member: a request that is already
 * COMPLETED must not be collected a second time.
 */
const lockTrip = async (tx, { driverProfileId, ridePoolId }) => {
  const pool = await lockPool(tx, ridePoolId);
  if (!pool || pool.driverProfileId !== driverProfileId) throw poolNotFound(ridePoolId);

  const stops = await lockPoolStops(tx, ridePoolId);

  const rows = await tx.poolMember.findMany({
    where: { ridePoolId },
    orderBy: { matchedAt: 'asc' },
    select: {
      id: true,
      status: true,
      rideRequestId: true,
      matchedAt: true,
      pickedUpAt: true,
      droppedOffAt: true,
    },
  });

  const requests = await lockMemberRequests(tx, rows);

  const members = rows.map((member) => ({
    ...member,
    requestId: member.rideRequestId,
    requestStatus: requests.get(member.rideRequestId)?.status ?? null,
  }));

  const fare = await tx.poolFareCalculation.findFirst({
    where: {
      ridePoolId,
      status: { in: ['CURRENT', 'FINALIZED'] },
    },
    orderBy: [{ poolVersion: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, status: true, poolVersion: true, finalizedAt: true },
  });

  return { pool, stops, members, requests, fare };
};

/** The pool's own status move, checked against the one transition table. */
const movePoolStatus = async (tx, { pool, to, now, timestamps = {} }) => {
  if (!canChangePoolStatus(pool.status, to)) {
    throw new ApiError(500, `A pool cannot move from ${pool.status} to ${to}`);
  }

  await tx.ridePool.update({
    where: { id: pool.id },
    data: { status: to, ...timestamps },
    select: { id: true },
  });

  return { from: pool.status, to };
};

/** The decision is the answer; a refusal is a conflict, a repeat is a no-op. */
const assertApplied = (decision, action) => {
  if (decision.decision === TRIP_DECISION.REFUSE) {
    throw new ApiError(409, decision.message ?? `This pool cannot ${action} yet`);
  }

  return decision.decision === TRIP_DECISION.APPLY;
};

const requireDriverStatus = (driverRow, expected, message) => {
  if (!driverRow || driverRow.status !== expected) throw new ApiError(409, message);
};

/**
 * Ends every join offer the pool still has pending.
 *
 * A pool being driven is closed to matching, so an offer that proposed adding a
 * passenger to it is dead: it is cancelled rather than left to expire, because a
 * pending offer also occupies the *offered driver's* single offer slot and the
 * offered passenger's request.
 *
 * `lockedRequestIds` are the requests this transaction already holds a lock on,
 * and only those get a `DRIVER_OFFER_CANCELLED` on their timeline: writing one
 * needs that request's row lock, and asking for it here would be asking for it
 * after the pool -- the order that deadlocks against a concurrent acceptance. An
 * offer that appeared while this departure was running is cancelled without an
 * event; its passenger is re-offered by the dispatcher and their timeline records
 * that instead.
 */
const cancelPendingJoinOffers = async (tx, { pool, lockedRequestIds, now }) => {
  const offers = await tx.dispatchOffer.findMany({
    where: {
      ridePoolId: pool.id,
      status: OFFER_STATUS.PENDING,
      offerType: OFFER_TYPE.ADD_PASSENGER,
    },
    orderBy: { offeredAt: 'asc' },
    select: { id: true, rideRequestId: true, driverProfileId: true, poolVersion: true },
  });

  const cancelled = [];

  for (const offer of offers) {
    // eslint-disable-next-line no-await-in-loop
    await tx.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: OFFER_STATUS.CANCELLED, respondedAt: now },
    });

    cancelled.push(offer);

    if (lockedRequestIds.has(offer.rideRequestId)) {
      // eslint-disable-next-line no-await-in-loop
      const request = await tx.rideRequest.findUnique({
        where: { id: offer.rideRequestId },
        select: { status: true },
      });

      // eslint-disable-next-line no-await-in-loop
      await appendRideEvent(tx, {
        rideRequestId: offer.rideRequestId,
        eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_CANCELLED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: request?.status ?? RIDE_REQUEST_STATUS.WAITING,
        newStatus: request?.status ?? RIDE_REQUEST_STATUS.WAITING,
        metadata: {
          offerId: offer.id,
          ridePoolId: pool.id,
          driverProfileId: offer.driverProfileId,
          poolVersion: offer.poolVersion,
          reason: 'pool_departed',
        },
        now,
      });
    }
  }

  return cancelled;
};

/**
 * Reads the join offers a pool has pending, without locking anything.
 *
 * Only used to learn which requests a departure has to lock *before* the pool.
 * The set can grow between this read and the transaction, which is why the
 * offers are re-read under the pool's lock; this read only decides the order.
 */
const pendingJoinRequestIds = async (ridePoolId) => {
  const offers = await prisma.dispatchOffer.findMany({
    where: {
      ridePoolId,
      status: OFFER_STATUS.PENDING,
      offerType: OFFER_TYPE.ADD_PASSENGER,
    },
    select: { rideRequestId: true },
  });

  return offers.map((offer) => offer.rideRequestId).sort();
};

// ---------------------------------------------------------------------------
// 1. Departure
// ---------------------------------------------------------------------------

/**
 * The driver sets off for the first pickup.
 *
 * This is the operation that turns a plan into a trip: the pool closes to
 * matching, the fare is frozen, the driver stops being available for anything
 * else, and the pending proposals to add another passenger are cancelled. All of
 * it commits together, so there is no moment at which a pool is being driven but
 * still matchable, or driven for a price nobody settled.
 */
export const departPool = async ({ driver, ridePoolId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  // Before the pool lock: the requests this departure will have to write to.
  const joinRequestIds = await pendingJoinRequestIds(ridePoolId);

  const outcome = await inTransaction(async (tx) => {
    // 1. The requests behind the pending join offers, first -- see LOCK ORDER.
    const lockedRequestIds = new Set();
    for (const requestId of joinRequestIds) {
      // eslint-disable-next-line no-await-in-loop
      await lockRideRequest(tx, requestId);
      lockedRequestIds.add(requestId);
    }

    // 2-4. The pool, its stops, its members and their requests.
    const { pool, stops, members, fare } = await lockTrip(tx, { driverProfileId, ridePoolId });

    const decision = decideDepart({ pool, stops, members });
    if (!assertApplied(decision, 'depart')) {
      return { applied: false, releasedRequestIds: [] };
    }

    // 5. The driver is still the one who accepted this pool.
    const driverRow = await lockDriver(tx, driverProfileId);
    requireDriverStatus(driverRow, DRIVER_AVAILABILITY.RESERVED, 'You are no longer assigned to this pool');

    // 6. The fare the trip runs under. Frozen before the departure is written, so
    // a pool cannot be under way without one.
    const settled = await finalizePoolFareCalculation({ tx, ridePoolId, now });

    // 7. The proposals that a departure invalidates.
    const cancelledOffers = await cancelPendingJoinOffers(tx, {
      pool,
      lockedRequestIds,
      now,
    });

    // 8. The trip starts moving, and the driver is committed to it.
    const statusChange = await movePoolStatus(tx, {
      pool,
      to: POOL_STATUS.DRIVER_EN_ROUTE,
      now,
      timestamps: { departedAt: now },
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { status: DRIVER_AVAILABILITY.ON_RIDE, availableSince: null, lastSeenAt: now },
    });

    // 9. The pool's own record of setting off.
    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.DRIVER_DEPARTED,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        statusBefore: statusChange.from,
        statusAfter: statusChange.to,
        poolVersion: pool.version,
        stopCount: stops.length,
        memberCount: members.length,
        occupiedSeats: members.length,
        fareCalculationId: settled.calculationId,
        farePoolVersion: settled.poolVersion,
        fareStatus: 'FINALIZED',
        cancelledOfferIds: cancelledOffers.map((offer) => offer.id),
        firstStopSequence: firstPickupStop(stops)?.sequence ?? null,
        // Kept for the fare milestone's audit trail: the calculation the trip is
        // running under, not any passenger's amount.
        departedAt: now.toISOString(),
      },
      now,
    });

    return {
      applied: true,
      releasedRequestIds: cancelledOffers
        .filter((offer) => lockedRequestIds.has(offer.rideRequestId))
        .map((offer) => offer.rideRequestId),
      fare: settled,
    };
  });

  return { outcome, ridePoolId };
};

// ---------------------------------------------------------------------------
// 2. Arriving at a stop
// ---------------------------------------------------------------------------

/**
 * The driver reaches a stop.
 *
 * Reaching the first pickup is what moves the pool out of `DRIVER_EN_ROUTE`, so
 * the passengers waiting for it can be told the car is there; a later arrival
 * leaves the pool exactly as it was, which is why the same call serves both.
 */
export const arriveAtStop = async ({ driver, ridePoolId, stopId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const outcome = await inTransaction(async (tx) => {
    const { pool, stops, members } = await lockTrip(tx, { driverProfileId, ridePoolId });

    const stop = stops.find((candidate) => candidate.id === stopId);
    if (!stop) throw stopNotFound(stopId);

    const decision = decideArrival({ pool, stop, stops });
    if (!assertApplied(decision, 'reach this stop')) return { applied: false };

    await lockDriver(tx, driverProfileId);

    const reachedAt = now;
    await tx.poolStop.update({
      where: { id: stop.id },
      data: { status: POOL_STOP_STATUS.ARRIVED, actualArrivalAt: reachedAt },
      select: { id: true },
    });

    // The first pickup is what the pool's own `driver_arrived_at` records: later
    // arrivals are stop facts and belong on the stop.
    const first = firstPickupStop(stops);
    let statusChange = null;

    if (pool.status === POOL_STATUS.DRIVER_EN_ROUTE && first && first.id === stop.id) {
      statusChange = await movePoolStatus(tx, {
        pool,
        to: POOL_STATUS.ARRIVED,
        now,
        timestamps: { driverArrivedAt: reachedAt },
      });
    }

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { lastSeenAt: now },
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.STOP_ARRIVED,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        stopId: stop.id,
        sequence: stop.sequence,
        stopType: stop.stopType,
        poolMemberId: stop.poolMemberId,
        stopStatusBefore: stop.status,
        stopStatusAfter: POOL_STOP_STATUS.ARRIVED,
        poolStatusBefore: statusChange?.from ?? pool.status,
        poolStatusAfter: statusChange?.to ?? pool.status,
        reachedAt: reachedAt.toISOString(),
      },
      now,
    });

    // Only the passengers this stop belongs to hear about it, and only when it is
    // the stop they get in at: "the car is at your pickup" is what a passenger
    // waiting on a street corner needs, and reaching their drop-off is not
    // something they need to be told. With one stop per passenger, "associated
    // with that stop" is that stop's member. A passenger whose stop has not been
    // reached is told nothing -- they cannot see where the driver is.
    const member =
      stop.stopType === POOL_STOP_TYPE.PICKUP
        ? members.find((candidate) => candidate.id === stop.poolMemberId)
        : null;

    if (member) {
      await appendRideEvent(tx, {
        rideRequestId: member.rideRequestId,
        eventType: RIDE_EVENT_TYPE.DRIVER_ARRIVED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: member.requestStatus,
        newStatus: member.requestStatus,
        metadata: {
          ridePoolId: pool.id,
          stopId: stop.id,
          stopSequence: stop.sequence,
          stopType: stop.stopType,
          poolStatus: statusChange?.to ?? pool.status,
        },
        now,
      });
    }

    return { applied: true, poolStatus: statusChange?.to ?? pool.status };
  });

  return { outcome, ridePoolId };
};

// ---------------------------------------------------------------------------
// 3. Collecting a passenger
// ---------------------------------------------------------------------------

/**
 * A passenger gets in.
 *
 * The stop finishes with the pickup, because a stop belongs to one passenger:
 * another passenger collected at the same corner has their own stop, still ahead
 * in the order, which is what keeps a shared corner open until everybody there
 * is aboard.
 *
 * A passenger collected before the trip starts stays `MATCHED` until the driver
 * starts it. One collected *during* a started trip begins their ride immediately,
 * because their ride is what the car is already doing.
 */
export const pickUpMember = async ({
  driver,
  ridePoolId,
  stopId,
  memberId,
  now = new Date(),
}) => {
  const driverProfileId = requireDriverProfileId(driver);

  const outcome = await inTransaction(async (tx) => {
    const { pool, stops, members, requests } = await lockTrip(tx, {
      driverProfileId,
      ridePoolId,
    });

    const stop = stops.find((candidate) => candidate.id === stopId);
    if (!stop) throw stopNotFound(stopId);

    const member = members.find((candidate) => candidate.id === memberId);
    if (!member) throw memberNotFound(memberId);

    const decision = decidePickup({ pool, stop, member, stops, members });
    if (!assertApplied(decision, 'collect this passenger')) return { applied: false };

    await lockDriver(tx, driverProfileId);

    await tx.poolMember.update({
      where: { id: member.id },
      data: { status: POOL_MEMBER_STATUS.PICKED_UP, pickedUpAt: now },
      select: { id: true },
    });

    // The stop's own action is done: it has no other passenger to wait for.
    await tx.poolStop.update({
      where: { id: stop.id },
      data: { status: POOL_STOP_STATUS.COMPLETED, completedAt: now },
      select: { id: true },
    });

    const request = requests.get(member.rideRequestId);
    const rideStarted = pool.status === POOL_STATUS.IN_PROGRESS;

    if (rideStarted && request.status === RIDE_REQUEST_STATUS.MATCHED) {
      await applyRideRequestTransition(tx, {
        request,
        toStatus: RIDE_REQUEST_STATUS.IN_PROGRESS,
        eventType: RIDE_EVENT_TYPE.RIDE_STARTED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        actorUserId: driver.id,
        metadata: {
          ridePoolId: pool.id,
          poolMemberId: member.id,
          stopId: stop.id,
          reason: 'collected_during_trip',
        },
        now,
        startedAt: now,
      });
    }

    await appendRideEvent(tx, {
      rideRequestId: member.rideRequestId,
      eventType: RIDE_EVENT_TYPE.PASSENGER_PICKED_UP,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      actorUserId: driver.id,
      previousStatus: request.status,
      newStatus: rideStarted ? RIDE_REQUEST_STATUS.IN_PROGRESS : request.status,
      metadata: {
        ridePoolId: pool.id,
        poolMemberId: member.id,
        stopId: stop.id,
        stopSequence: stop.sequence,
        poolStatus: pool.status,
      },
      now,
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { lastSeenAt: now },
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.MEMBER_PICKED_UP,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        poolMemberId: member.id,
        rideRequestId: member.rideRequestId,
        stopId: stop.id,
        stopSequence: stop.sequence,
        memberStatusBefore: member.status,
        memberStatusAfter: POOL_MEMBER_STATUS.PICKED_UP,
        stopStatusAfter: POOL_STOP_STATUS.COMPLETED,
        poolStatus: pool.status,
        pickedUpAt: now.toISOString(),
        occupancyAfter: onboardMemberIds(members).length + 1,
      },
      now,
    });

    return { applied: true, rideStarted };
  });

  return { outcome, ridePoolId };
};

// ---------------------------------------------------------------------------
// 4. Starting the trip
// ---------------------------------------------------------------------------

/**
 * The journey begins with the passengers who are already in the vehicle.
 *
 * Passengers waiting further along the route stay `MATCHED` and are started when
 * they get in, which is what lets one pool be `IN_PROGRESS` while somebody booked
 * into it has not been collected yet.
 */
export const startTrip = async ({ driver, ridePoolId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const outcome = await inTransaction(async (tx) => {
    const { pool, stops, members, requests, fare } = await lockTrip(tx, {
      driverProfileId,
      ridePoolId,
    });

    const decision = decideStart({ pool, stops, members, fare });
    if (!assertApplied(decision, 'start this trip')) return { applied: false };

    const driverRow = await lockDriver(tx, driverProfileId);
    requireDriverStatus(
      driverRow,
      DRIVER_AVAILABILITY.ON_RIDE,
      'You are no longer driving this pool',
    );

    const statusChange = await movePoolStatus(tx, {
      pool,
      to: POOL_STATUS.IN_PROGRESS,
      now,
      timestamps: { startedAt: now },
    });

    const started = [];

    for (const member of members) {
      if (member.status !== POOL_MEMBER_STATUS.PICKED_UP) continue;

      const request = requests.get(member.rideRequestId);

      if (request.status === RIDE_REQUEST_STATUS.IN_PROGRESS) continue;

      // eslint-disable-next-line no-await-in-loop
      await applyRideRequestTransition(tx, {
        request,
        toStatus: RIDE_REQUEST_STATUS.IN_PROGRESS,
        eventType: RIDE_EVENT_TYPE.RIDE_STARTED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        actorUserId: driver.id,
        metadata: {
          ridePoolId: pool.id,
          poolMemberId: member.id,
          startedAt: now.toISOString(),
        },
        now,
        startedAt: now,
      });

      started.push(member.id);
    }

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { lastSeenAt: now },
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.TRIP_STARTED,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        statusBefore: statusChange.from,
        statusAfter: statusChange.to,
        startedAt: now.toISOString(),
        startedMemberIds: started,
        // Who is in the car, and who is still to be collected.
        onboardMemberIds: onboardMemberIds(members),
        waitingMemberIds: members
          .filter((member) => member.status === POOL_MEMBER_STATUS.ASSIGNED)
          .map((member) => member.id),
        fareCalculationId: fare?.id ?? null,
      },
      now,
    });

    return { applied: true, startedMemberIds: started };
  });

  return { outcome, ridePoolId };
};

// ---------------------------------------------------------------------------
// 5. Delivering a passenger
// ---------------------------------------------------------------------------

/**
 * A passenger is delivered.
 *
 * Their ride ends here -- the member, the stop and the request all finish, and
 * the ride appears in their history -- while the pool stays `IN_PROGRESS` for
 * whoever is still aboard. The pool is only over when the last of them is out.
 */
export const dropOffMember = async ({
  driver,
  ridePoolId,
  stopId,
  memberId,
  now = new Date(),
}) => {
  const driverProfileId = requireDriverProfileId(driver);

  const outcome = await inTransaction(async (tx) => {
    const { pool, stops, members, requests } = await lockTrip(tx, {
      driverProfileId,
      ridePoolId,
    });

    const stop = stops.find((candidate) => candidate.id === stopId);
    if (!stop) throw stopNotFound(stopId);

    const member = members.find((candidate) => candidate.id === memberId);
    if (!member) throw memberNotFound(memberId);

    const decision = decideDropoff({ pool, stop, member, stops, members });
    if (!assertApplied(decision, 'deliver this passenger')) return { applied: false };

    await lockDriver(tx, driverProfileId);

    const request = requests.get(member.rideRequestId);

    await tx.poolMember.update({
      where: { id: member.id },
      data: { status: POOL_MEMBER_STATUS.DROPPED_OFF, droppedOffAt: now },
      select: { id: true },
    });

    await tx.poolStop.update({
      where: { id: stop.id },
      data: { status: POOL_STOP_STATUS.COMPLETED, completedAt: now },
      select: { id: true },
    });

    await appendRideEvent(tx, {
      rideRequestId: member.rideRequestId,
      eventType: RIDE_EVENT_TYPE.PASSENGER_DROPPED_OFF,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      actorUserId: driver.id,
      previousStatus: request.status,
      newStatus: RIDE_REQUEST_STATUS.COMPLETED,
      metadata: {
        ridePoolId: pool.id,
        poolMemberId: member.id,
        stopId: stop.id,
        stopSequence: stop.sequence,
        droppedOffAt: now.toISOString(),
      },
      now,
    });

    // The passenger's ride is complete, and their history says so immediately --
    // the pool carries on.
    await applyRideRequestTransition(tx, {
      request,
      toStatus: RIDE_REQUEST_STATUS.COMPLETED,
      eventType: RIDE_EVENT_TYPE.RIDE_COMPLETED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      actorUserId: driver.id,
      metadata: {
        ridePoolId: pool.id,
        poolMemberId: member.id,
        stopId: stop.id,
        completedAt: now.toISOString(),
      },
      now,
      completedAt: now,
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { lastSeenAt: now },
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.MEMBER_DROPPED_OFF,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        poolMemberId: member.id,
        rideRequestId: member.rideRequestId,
        stopId: stop.id,
        stopSequence: stop.sequence,
        memberStatusBefore: member.status,
        memberStatusAfter: POOL_MEMBER_STATUS.DROPPED_OFF,
        stopStatusAfter: POOL_STOP_STATUS.COMPLETED,
        poolStatus: pool.status,
        droppedOffAt: now.toISOString(),
        stillOnboard: onboardMemberIds(members).length - 1,
      },
      now,
    });

    return { applied: true, remainingOnboard: onboardMemberIds(members).length - 1 };
  });

  return { outcome, ridePoolId };
};

// ---------------------------------------------------------------------------
// 6. Completing the trip
// ---------------------------------------------------------------------------

/**
 * The pool is over, and the driver is free again.
 *
 * Completion is the only operation that changes what the *driver* is: they go
 * from `ON_RIDE` back to `AVAILABLE`, at the place they finished, and the seat
 * they were holding is released. Nothing starts a new pool here -- a driver who
 * wants another ride goes through dispatch like anybody else.
 */
export const completeTrip = async ({ driver, ridePoolId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const outcome = await inTransaction(async (tx) => {
    const { pool, stops, members, fare } = await lockTrip(tx, { driverProfileId, ridePoolId });

    const decision = decideCompletion({ pool, stops, members, fare });
    if (!assertApplied(decision, 'complete this trip')) return { applied: false };

    const driverRow = await lockDriver(tx, driverProfileId);
    requireDriverStatus(
      driverRow,
      DRIVER_AVAILABILITY.ON_RIDE,
      'You are no longer driving this pool',
    );

    const statusChange = await movePoolStatus(tx, {
      pool,
      to: POOL_STATUS.COMPLETED,
      now,
      timestamps: { completedAt: now },
    });

    // The driver ends up where the trip ended. The availability CHECK requires a
    // current point, so this is also what makes them available at all.
    const last = finalDropoffStop(stops);
    const endedAtPointId = last?.servicePointId ?? driverRow.currentServicePointId ?? null;

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        status: DRIVER_AVAILABILITY.AVAILABLE,
        availableSince: now,
        lastSeenAt: now,
        currentServicePointId: endedAtPointId,
      },
    });

    // TeslaPay: the journey is over, so each passenger now owes the amount they
    // were already told they owed. This runs here rather than in a sweeper
    // because a completed trip without its debts is a state the product cannot
    // reach -- and `payments_ride_request_key` makes a retried completion a
    // no-op instead of a double charge.
    await createPaymentsForPool({ tx, ridePoolId, now });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.TRIP_COMPLETED,
      actorType: POOL_ACTOR_TYPE.DRIVER,
      actorUserId: driver.id,
      metadata: {
        statusBefore: statusChange.from,
        statusAfter: statusChange.to,
        completedAt: now.toISOString(),
        stopCount: stops.length,
        memberCount: members.length,
        fareCalculationId: fare?.id ?? null,
        farePoolVersion: fare?.poolVersion ?? null,
      },
      now,
    });

    await appendPoolEvent(tx, {
      ridePoolId: pool.id,
      eventType: POOL_EVENT_TYPE.DRIVER_AVAILABLE,
      actorType: POOL_ACTOR_TYPE.SYSTEM,
      metadata: {
        driverProfileId,
        driverStatusBefore: DRIVER_AVAILABILITY.ON_RIDE,
        driverStatusAfter: DRIVER_AVAILABILITY.AVAILABLE,
        availableSince: now.toISOString(),
        endedAtServicePointId: endedAtPointId,
      },
      now,
    });

    return { applied: true, endedAtPointId };
  });

  return { outcome, ridePoolId };
};
