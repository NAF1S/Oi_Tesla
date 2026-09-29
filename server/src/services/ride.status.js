import { createHash } from 'node:crypto';

/**
 * The ride-request lifecycle as data: statuses, the transitions the product
 * allows, cancellation reasons, and how a request is fingerprinted.
 *
 * Nothing here touches the database, which is what makes the transition rules
 * unit-testable and keeps one definition of them for the service, the triggers
 * in 08-ride-requests.sql and the tests.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST IS ONE PASSENGER
 * ---------------------------------------------------------------------------
 * There is no seat count, no requested-seat field and no per-seat fare anywhere
 * in this module -- or anywhere else in the milestone. A request represents one
 * passenger travelling from one pickup point to one destination point, and
 * future capacity planning counts assigned passenger requests.
 *
 * ---------------------------------------------------------------------------
 * TRANSITIONS
 * ---------------------------------------------------------------------------
 * Implemented:
 *
 *     WAITING     -> MATCHED            (a driver accepted a dispatch offer)
 *     WAITING     -> CANCELLED
 *     WAITING     -> EXPIRED
 *     MATCHED     -> IN_PROGRESS        (trip start, or collected during one)
 *     IN_PROGRESS -> COMPLETED          (the passenger was delivered)
 *
 * Reserved for a later milestone (allowed by the database trigger, unreachable
 * from the API because no operation performs it):
 *
 *     MATCHED     -> CANCELLED        (cancelling a matched request)
 *
 * Terminal statuses are terminal: COMPLETED, CANCELLED and EXPIRED have no
 * outgoing transition at all.
 */

export const RIDE_REQUEST_STATUS = Object.freeze({
  WAITING: 'WAITING',
  MATCHED: 'MATCHED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

export const RIDE_REQUEST_STATUSES = Object.freeze(Object.values(RIDE_REQUEST_STATUS));

/**
 * A request in one of these states occupies the passenger's single active slot,
 * which is exactly the set the partial unique index covers.
 */
export const ACTIVE_RIDE_REQUEST_STATUSES = Object.freeze([
  RIDE_REQUEST_STATUS.WAITING,
  RIDE_REQUEST_STATUS.MATCHED,
  RIDE_REQUEST_STATUS.IN_PROGRESS,
]);

export const TERMINAL_RIDE_REQUEST_STATUSES = Object.freeze([
  RIDE_REQUEST_STATUS.COMPLETED,
  RIDE_REQUEST_STATUS.CANCELLED,
  RIDE_REQUEST_STATUS.EXPIRED,
]);

export const RIDE_EVENT_TYPE = Object.freeze({
  RIDE_REQUESTED: 'RIDE_REQUESTED',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
  RIDE_EXPIRED: 'RIDE_EXPIRED',
  // Dispatch. DRIVER_OFFERED is written when an offer is created, and the other
  // three record how it ended; PASSENGER_MATCHED (below) is the match itself.
  DRIVER_OFFERED: 'DRIVER_OFFERED',
  DRIVER_REJECTED: 'DRIVER_REJECTED',
  DRIVER_OFFER_EXPIRED: 'DRIVER_OFFER_EXPIRED',
  DRIVER_OFFER_CANCELLED: 'DRIVER_OFFER_CANCELLED',
  DRIVER_ACCEPTED: 'DRIVER_ACCEPTED',
  // Shared matching: a pool was considered, offered, refused, joined, or given up
  // on in favour of finding the passenger a driver of their own.
  POOL_CANDIDATE_EVALUATED: 'POOL_CANDIDATE_EVALUATED',
  POOL_JOIN_OFFERED: 'POOL_JOIN_OFFERED',
  POOL_JOIN_REJECTED: 'POOL_JOIN_REJECTED',
  POOL_JOIN_ACCEPTED: 'POOL_JOIN_ACCEPTED',
  INITIAL_DISPATCH_FALLBACK: 'INITIAL_DISPATCH_FALLBACK',
  // The match. The name already existed and is reused rather than duplicated
  // under a second name -- it is the moment a request stops waiting.
  PASSENGER_MATCHED: 'PASSENGER_MATCHED',
  // Shared fares: this passenger has been priced for a pool plan, and -- when a
  // cap brought their fare down -- that a cap did so. Both carry only that
  // passenger's own amounts.
  PASSENGER_FARE_ALLOCATED: 'PASSENGER_FARE_ALLOCATED',
  PASSENGER_FARE_REDUCED: 'PASSENGER_FARE_REDUCED',
  // The trip. RIDE_STARTED, RIDE_COMPLETED, PASSENGER_PICKED_UP and
  // PASSENGER_DROPPED_OFF already existed; DRIVER_ARRIVED is the one the trip
  // adds, because "the car is at your pickup" had no name of its own.
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  RIDE_STARTED: 'RIDE_STARTED',
  RIDE_COMPLETED: 'RIDE_COMPLETED',
  PASSENGER_PICKED_UP: 'PASSENGER_PICKED_UP',
  PASSENGER_DROPPED_OFF: 'PASSENGER_DROPPED_OFF',
  // TeslaPay. The journey was settled, and the method is in the metadata.
  RIDE_PAID: 'RIDE_PAID',
});

export const RIDE_ACTOR_TYPE = Object.freeze({
  PASSENGER: 'PASSENGER',
  SYSTEM: 'SYSTEM',
  ADMIN: 'ADMIN',
});

export const CANCELLATION_REASONS = Object.freeze([
  'CHANGED_MIND',
  'WRONG_LOCATION',
  'WAIT_TOO_LONG',
  'OTHER',
]);

/** The reason recorded when a passenger cancels without saying why. */
export const DEFAULT_CANCELLATION_REASON = 'OTHER';

/**
 * Every transition the product defines, keyed by the status it starts from.
 *
 * This is the single source of truth: `enforce_ride_request_update()` in
 * 08-ride-requests.sql encodes the same table, so a status change that bypasses
 * the transition service is refused by the database as well.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [RIDE_REQUEST_STATUS.WAITING]: Object.freeze([
    RIDE_REQUEST_STATUS.MATCHED,
    RIDE_REQUEST_STATUS.CANCELLED,
    RIDE_REQUEST_STATUS.EXPIRED,
  ]),
  [RIDE_REQUEST_STATUS.MATCHED]: Object.freeze([
    RIDE_REQUEST_STATUS.IN_PROGRESS,
    RIDE_REQUEST_STATUS.CANCELLED,
  ]),
  [RIDE_REQUEST_STATUS.IN_PROGRESS]: Object.freeze([RIDE_REQUEST_STATUS.COMPLETED]),
  [RIDE_REQUEST_STATUS.COMPLETED]: Object.freeze([]),
  [RIDE_REQUEST_STATUS.CANCELLED]: Object.freeze([]),
  [RIDE_REQUEST_STATUS.EXPIRED]: Object.freeze([]),
});

/**
 * Transitions this codebase implements. Everything else in ALLOWED_TRANSITIONS
 * is reserved: permitted by the database so no migration is needed later, but not
 * reachable, because no operation performs it.
 *
 * The only reserved one left is MATCHED -> CANCELLED: cancelling a ride that a
 * driver has already accepted, which is a product decision with money and a
 * passenger's seat attached, and belongs to a milestone about cancellation.
 */
export const IMPLEMENTED_TRANSITIONS = Object.freeze({
  [RIDE_REQUEST_STATUS.WAITING]: Object.freeze([
    RIDE_REQUEST_STATUS.MATCHED,
    RIDE_REQUEST_STATUS.CANCELLED,
    RIDE_REQUEST_STATUS.EXPIRED,
  ]),
  // The trip: starting the journey, or collecting a passenger while one is under
  // way. Both are the moment this passenger's ride begins.
  [RIDE_REQUEST_STATUS.MATCHED]: Object.freeze([RIDE_REQUEST_STATUS.IN_PROGRESS]),
  // The trip: delivering this passenger.
  [RIDE_REQUEST_STATUS.IN_PROGRESS]: Object.freeze([RIDE_REQUEST_STATUS.COMPLETED]),
});

export const isRideRequestStatus = (value) =>
  typeof value === 'string' && RIDE_REQUEST_STATUSES.includes(value);

export const isCancellationReason = (value) =>
  typeof value === 'string' && CANCELLATION_REASONS.includes(value);

export const isActiveStatus = (status) => ACTIVE_RIDE_REQUEST_STATUSES.includes(status);

export const isTerminalStatus = (status) => TERMINAL_RIDE_REQUEST_STATUSES.includes(status);

/** True when the product allows `from -> to` at all (implemented or reserved). */
export const canTransition = (from, to) =>
  Array.isArray(ALLOWED_TRANSITIONS[from]) && ALLOWED_TRANSITIONS[from].includes(to);

/** True when this milestone actually performs `from -> to`. */
export const isImplementedTransition = (from, to) =>
  Array.isArray(IMPLEMENTED_TRANSITIONS[from]) && IMPLEMENTED_TRANSITIONS[from].includes(to);

/** A request may be cancelled by its passenger only while it is still waiting. */
export const isCancellable = (status) => status === RIDE_REQUEST_STATUS.WAITING;

/**
 * The canonical fingerprint of a request's inputs.
 *
 * Two attempts with the same idempotency key are "the same request" only if they
 * describe the same thing; the fingerprint is what makes that comparison
 * possible. It is computed here, from server-derived values, and a client can
 * never send one.
 *
 * The field order is fixed by this function, so the digest is stable across
 * processes and Node versions, and it covers everything that materially defines
 * the request -- not just the quote id, because a quote could in principle be
 * re-quoted with the same id only if something is badly wrong, and because the
 * accepted fare belongs in the fingerprint of what was agreed.
 */
export const requestFingerprint = ({
  passengerProfileId,
  fareQuoteId,
  pickupServicePointId,
  dropoffServicePointId,
  acceptedFare,
  currency,
  acceptedPricingCode,
  acceptedPricingVersion,
  acceptedDistanceMeters,
  acceptedDurationSeconds,
}) => {
  const canonical = JSON.stringify([
    'ride-request.v1',
    passengerProfileId,
    fareQuoteId,
    pickupServicePointId,
    dropoffServicePointId,
    // The fare is already rounded exactly by the fare service; `toString` on a
    // Decimal is exact and never goes through a float.
    String(acceptedFare),
    currency,
    acceptedPricingCode,
    Number(acceptedPricingVersion),
    Number(acceptedDistanceMeters),
    Number(acceptedDurationSeconds),
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};
