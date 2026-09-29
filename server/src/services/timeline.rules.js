/**
 * The lifecycle timeline as data: which internal event a person may be told
 * about, and what they are told.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `ride_events` and `pool_events` are audit tables. They are append-only, they
 * carry a `metadata` JSON column, and the dispatch and matching code writes them
 * so an operator can reconstruct exactly what happened. That is not the same as a
 * timeline a passenger or a driver should be shown.
 *
 * The two audiences are not symmetric, and neither is the same as the audit:
 *
 *   * A **ride event** belongs to one passenger's request. Every row for that
 *     request is about *them* -- but several (`DRIVER_OFFERED`, `DRIVER_REJECTED`,
 *     `POOL_CANDIDATE_EVALUATED`, `POOL_JOIN_OFFERED`, …) describe the dispatch
 *     machinery: which driver was asked, whether they refused, what a candidate
 *     scored, that a join offer went to somebody. A passenger is shown their own
 *     journey, not the marketplace that produced it.
 *   * A **pool event** belongs to the driver's pool. It is genuinely the driver's
 *     record -- they performed the stops -- so the driver sees the operational
 *     ones, and the fare events too, because a driver's completed history
 *     legitimately reports what the trip came to. (The pool they are *currently*
 *     driving still shows no money; see `pool.serializer.js`.)
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 * ---------------------------------------------------------------------------
 * 1. **One entry per event type.** `pool_event_type` and `ride_event_type` are
 *    separate Postgres enums but share a vocabulary, so two maps merged into one
 *    would silently lose whichever was spread second if a name appeared in both.
 *    One event type therefore has exactly one entry, and the label varies by
 *    audience inside it.
 * 2. **Whitelist, not blacklist.** An event with no entry, or an entry that does
 *    not list the audience asking, is dropped. A new enum value added by a later
 *    milestone is therefore invisible until somebody decides what it means to
 *    whom and writes a label for it.
 * 3. **`metadata` is never read.** Entries are built from a fixed set of fields;
 *    the JSON audit payload has no path into a response.
 * 4. **`actorUserId` is never read.** It names the account that acted, which is
 *    never needed to say "your driver set off".
 * 5. **The order is `sequence`, then `createdAt`, then `id`.** Sequence is per
 *    request/pool and unique, so it is already total; the other two are there so a
 *    merged or hand-built list still has one deterministic order rather than
 *    whatever the database returned.
 *
 * Nothing here touches the database, and this file is the single definition the
 * passenger endpoint, the driver endpoint, the tests and the OpenAPI examples
 * share.
 */

/** Who is allowed to see an entry. */
export const TIMELINE_AUDIENCE = Object.freeze({
  PASSENGER: 'PASSENGER',
  DRIVER: 'DRIVER',
});

/**
 * Coarse grouping for a client, so a frontend can put the timeline into sections
 * without parsing labels or reimplementing the state machine.
 */
export const TIMELINE_PHASE = Object.freeze({
  REQUEST: 'REQUEST',
  MATCHING: 'MATCHING',
  PICKUP: 'PICKUP',
  RIDE: 'RIDE',
  END: 'END',
});

const { PASSENGER, DRIVER } = TIMELINE_AUDIENCE;
const { REQUEST, MATCHING, PICKUP, RIDE, END } = TIMELINE_PHASE;

/**
 * The whole vocabulary, keyed by event type.
 *
 * `labels` is keyed by audience and must cover exactly the audiences listed, so
 * an entry cannot claim an audience it has no sentence for. `toTimelineEntry`
 * looks the label up by the audience it was asked for, and the whitelist check
 * runs first, so it always finds one.
 *
 * Absences, and why they are absences:
 *
 *   * `DRIVER_OFFERED`, `DRIVER_REJECTED`, `DRIVER_OFFER_EXPIRED`,
 *     `DRIVER_OFFER_CANCELLED`, `POOL_CANDIDATE_EVALUATED`, `POOL_JOIN_OFFERED`,
 *     `POOL_JOIN_REJECTED`, `INITIAL_DISPATCH_FALLBACK` -- dispatch mechanics.
 *     `DRIVER_REJECTED` is the important one: telling a passenger that four
 *     drivers said no is a product decision nobody has made, and it is
 *     information about the drivers, not about the journey.
 *   * `ROUTE_PLAN_CREATED`, `JOIN_PLAN_CREATED`, `ROUTE_PLAN_UPDATED` -- the
 *     driver's DTO already carries `stops` and `nextStop`, which is the same fact
 *     rendered usefully. The events add nothing a client can act on.
 *   * `POOL_STATUS_CHANGED`, `POOL_CANCELLED` -- reserved. Nothing writes them, so
 *     mapping them would describe a state the product cannot reach.
 *   * Every `ride_event_type` for the driver: `ride_events` are one passenger's
 *     record, and the driver gets the pool's own log instead.
 *   * Every `pool_event_type` for the passenger: a pool's history names its
 *     members and its plan, and a passenger has no business reading either.
 *
 * `DRIVER_DEPARTED` is the one that looks like it should be shared and is not.
 * Departure writes a **pool** event; no ride event carries it. A passenger learns
 * their driver set off from `stage` and `timeline.departedAt`, which are on their
 * own response -- not from an event of their own, because there is none.
 */
export const TIMELINE = Object.freeze({
  // --- The passenger's own request -----------------------------------------
  RIDE_REQUESTED: {
    audiences: [PASSENGER],
    phase: REQUEST,
    labels: { [PASSENGER]: 'Ride requested' },
  },
  RIDE_CANCELLED: {
    audiences: [PASSENGER],
    phase: END,
    labels: { [PASSENGER]: 'Ride cancelled' },
  },
  RIDE_EXPIRED: {
    audiences: [PASSENGER],
    phase: END,
    labels: { [PASSENGER]: 'No driver was found in time' },
  },
  PASSENGER_MATCHED: {
    audiences: [PASSENGER],
    phase: MATCHING,
    labels: { [PASSENGER]: 'You were matched with a driver' },
  },
  DRIVER_ACCEPTED: {
    audiences: [PASSENGER],
    phase: MATCHING,
    labels: { [PASSENGER]: 'Your driver accepted the trip' },
  },
  /**
   * This passenger's own fare, twice: once when sharing produced a number, and
   * once when a cap brought it down. The *amounts* are not in the label -- they
   * are in the response's own `sharedFare` block, one answer rather than two that
   * can disagree.
   */
  PASSENGER_FARE_ALLOCATED: {
    audiences: [PASSENGER],
    phase: MATCHING,
    labels: { [PASSENGER]: 'Your shared fare was calculated' },
  },
  PASSENGER_FARE_REDUCED: {
    audiences: [PASSENGER],
    phase: MATCHING,
    labels: { [PASSENGER]: 'Your shared fare was reduced' },
  },
  /**
   * A co-passenger joined the ride this passenger is already in.
   *
   * Included, and the one event about somebody else that is: the number of people
   * in the car is already published as an aggregate (`passengerCount`), so this
   * tells the passenger nothing the response does not already say -- while a
   * shared-ride timeline that silently omitted the second pickup would
   * misdescribe the product. The label names nobody, and the event's metadata
   * (which does name the joining member) is never read.
   */
  POOL_JOIN_ACCEPTED: {
    audiences: [PASSENGER],
    phase: MATCHING,
    labels: { [PASSENGER]: 'Someone joined your shared ride' },
  },
  DRIVER_ARRIVED: {
    audiences: [PASSENGER],
    phase: PICKUP,
    labels: { [PASSENGER]: 'Your driver arrived at your pickup' },
  },
  PASSENGER_PICKED_UP: {
    audiences: [PASSENGER],
    phase: PICKUP,
    labels: { [PASSENGER]: 'You were picked up' },
  },
  RIDE_STARTED: {
    audiences: [PASSENGER],
    phase: RIDE,
    labels: { [PASSENGER]: 'Your ride started' },
  },
  PASSENGER_DROPPED_OFF: {
    audiences: [PASSENGER],
    phase: END,
    labels: { [PASSENGER]: 'You were dropped off' },
  },
  RIDE_COMPLETED: {
    audiences: [PASSENGER],
    phase: END,
    labels: { [PASSENGER]: 'Ride completed' },
  },
  // TeslaPay. Without this entry the event would be written and then hidden:
  // an event type that is not in this map is invisible to everybody.
  RIDE_PAID: {
    audiences: [PASSENGER],
    phase: END,
    labels: { [PASSENGER]: 'Ride paid' },
  },

  // --- The driver's own pool -----------------------------------------------
  POOL_CREATED: {
    audiences: [DRIVER],
    phase: REQUEST,
    labels: { [DRIVER]: 'Pool created' },
  },
  MEMBER_ADDED: {
    audiences: [DRIVER],
    phase: MATCHING,
    labels: { [DRIVER]: 'A passenger joined the pool' },
  },
  SHARED_FARE_CALCULATED: {
    audiences: [DRIVER],
    phase: MATCHING,
    labels: { [DRIVER]: 'Shared fare calculated' },
  },
  SHARED_FARE_SUPERSEDED: {
    audiences: [DRIVER],
    phase: MATCHING,
    labels: { [DRIVER]: 'Shared fare recalculated' },
  },
  DRIVER_DEPARTED: {
    audiences: [DRIVER],
    phase: PICKUP,
    labels: { [DRIVER]: 'Departed for the first pickup' },
  },
  STOP_ARRIVED: {
    audiences: [DRIVER],
    phase: PICKUP,
    labels: { [DRIVER]: 'Arrived at a stop' },
  },
  MEMBER_PICKED_UP: {
    audiences: [DRIVER],
    phase: PICKUP,
    labels: { [DRIVER]: 'Passenger picked up' },
  },
  TRIP_STARTED: {
    audiences: [DRIVER],
    phase: RIDE,
    labels: { [DRIVER]: 'Trip started' },
  },
  MEMBER_DROPPED_OFF: {
    audiences: [DRIVER],
    phase: RIDE,
    labels: { [DRIVER]: 'Passenger dropped off' },
  },
  TRIP_COMPLETED: {
    audiences: [DRIVER],
    phase: END,
    labels: { [DRIVER]: 'Trip completed' },
  },
  DRIVER_AVAILABLE: {
    audiences: [DRIVER],
    phase: END,
    labels: { [DRIVER]: 'Driver available again' },
  },
});

/** Every event type this module knows about, in one list. */
export const TIMELINE_EVENT_TYPES = Object.freeze(Object.keys(TIMELINE));

/** The event types a given audience may be shown. */
export const visibleEventTypes = (audience) =>
  TIMELINE_EVENT_TYPES.filter((eventType) => TIMELINE[eventType].audiences.includes(audience));

/**
 * Whether an event of this type may be shown to this audience.
 *
 * Unknown types are never visible. That is the whole safety property: a milestone
 * that adds an enum value gets, by default, an event nobody is told about.
 */
export const isVisibleTo = (eventType, audience) => {
  const entry = TIMELINE[eventType];
  return Boolean(entry && entry.audiences.includes(audience));
};

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

/**
 * One event, as one timeline entry.
 *
 * Returns null for anything the audience may not see, so callers filter by calling
 * this rather than by re-checking `isVisibleTo`. A caller that forgets to filter
 * still cannot leak: the entry does not exist.
 *
 * `actorType` is carried through because it is a closed enum (`PASSENGER`,
 * `DRIVER`, `SYSTEM`, `ADMIN`) and says which *kind* of actor acted -- never which
 * one.
 */
export const toTimelineEntry = (event, audience) => {
  const entry = TIMELINE[event?.eventType];
  if (!entry || !entry.audiences.includes(audience)) return null;

  return {
    sequence: event.sequence,
    eventType: event.eventType,
    phase: entry.phase,
    label: entry.labels[audience],
    actorType: event.actorType ?? null,
    at: toIsoString(event.createdAt),
  };
};

/** Sequence first, then the instant, then the id. Never the input order. */
export const compareTimelineEntries = (a, b) => {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;

  const left = new Date(a.createdAt ?? 0).getTime();
  const right = new Date(b.createdAt ?? 0).getTime();
  if (left !== right) return left - right;

  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
};

/**
 * A whole history, in order, with everything the audience may not see removed.
 *
 * The sort is total: `sequence` is unique per request/pool, and the timestamp and
 * id tie-breakers make the order deterministic even for a list assembled from more
 * than one source. The input array is not mutated.
 */
export const toTimeline = (events, audience) => {
  const rows = Array.isArray(events) ? events : [];

  return rows
    .filter((event) => isVisibleTo(event?.eventType, audience))
    .sort(compareTimelineEntries)
    .map((event) => toTimelineEntry(event, audience));
};
