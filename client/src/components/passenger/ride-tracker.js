"use client";

import { useCallback, useState } from "react";

import { cancelRideRequest, getCurrentRide, getRideDetail } from "@/lib/passenger-api";
import { usePolling } from "@/lib/use-polling";
import { formatDistance, formatDuration, formatMoney, formatElapsed, formatTime } from "@/lib/format";
import { MEMBER_STATUS, NEXT_ACTION, PASSENGER_STAGE, POOL_STATUS, STOP_STATUS, isFinished } from "@/lib/ride-status";
import { Button, Facts, Heading, LinkButton, Notice, Panel } from "@/components/ui";
import { Chip, Labeled, PlaceLine, RideStatusChip } from "@/components/status-chip";
import { EmptyState, ErrorState, Loading } from "@/components/async-state";
import { SettlePayment } from "@/components/payment/settle-payment";
import { CancelRequest } from "./cancel-request";

/**
 * The passenger's live view of their ride.
 *
 * ---------------------------------------------------------------------------
 * POLLING
 * ---------------------------------------------------------------------------
 * There is no push in this project — no WebSockets, no notifications — so the only
 * way to learn that a driver has moved is to ask again. Polling is the honest
 * transport.
 *
 * *How* to ask — a recursive timeout rather than an interval, skipping a hidden
 * tab, resuming the moment it is looked at, cancelling on unmount, one request in
 * flight at a time — lives in `usePolling`, because the driver's console needs
 * exactly the same six rules and two copies of them would drift.
 *
 * *Whether* to keep asking is this component's, and it is one case: **the ride is
 * over, so stop**. The endpoint answers with an *active* ride only, so a ride that
 * finishes arrives as `null` and there is nothing left to learn. That is also what
 * makes the final screen stable rather than flickering, and it is why the
 * "completed or cancelled" requirement needs no status check here.
 *
 * A *failed* poll is not that case: the API being briefly unreachable is not the
 * ride disappearing, so the loop keeps trying and the screen keeps the last good
 * ride with a note saying the update failed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT SHOWN
 * ---------------------------------------------------------------------------
 * Only this passenger's own facts: their two stops, their fare, the driver's first
 * name and the car. The API cannot return a co-passenger's name, places, fare or
 * events, so there is nothing here to filter out — `passengerCount` is the one
 * shared fact, and it is a number.
 */

/** How often to ask. A few seconds is enough for a stop-based MVP. */
export const POLL_INTERVAL_MS = 5000;

export function RideTracker({ initialRide = null, pollIntervalMs = POLL_INTERVAL_MS }) {
  const [ride, setRide] = useState(initialRide);

  /**
   * The last ride that was actually there.
   *
   * `GET /passengers/me/current-ride` answers with an *active* ride or nothing, so
   * a ride that finishes arrives as `null` — and `ride` alone cannot tell "this
   * passenger never had one" apart from "the one they had is over". Keeping the
   * last non-null ride is what makes that distinction renderable, and it is state
   * rather than a ref because it is read *while rendering*.
   */
  const [lastRide, setLastRide] = useState(initialRide);
  const [error, setError] = useState(null);

  /**
   * The finished ride's own record, fetched once when the ride leaves the active
   * list.
   *
   * It is the difference between reporting and guessing. `current-ride` stops
   * answering as soon as a ride reaches `COMPLETED` or `CANCELLED`, so on its own
   * the tracker could say only "this ride is no longer active" — and the two
   * outcomes are the two things a passenger most wants to be right. The detail
   * endpoint has no status filter, so asking it settles the question with the
   * API's own answer.
   */
  const [finishedRide, setFinishedRide] = useState(null);
  const [finishing, setFinishing] = useState(false);

  /**
   * Calling the ride off, while the server still allows it.
   *
   * Two pieces of state rather than one: `busy` disables the form, and `cancelError`
   * is handed to the control so it can say *where* the failure happened. A `409` in
   * particular is not a failed cancellation — it is a driver having accepted at that
   * exact moment, which the next poll will show.
   */
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  /**
   * The browser's clock, or `null` until this component has run in a browser.
   *
   * "Requested 57 seconds ago" is a fact about *now*, so it cannot be rendered on
   * the server: the server's HTML would say 57 and the browser would hydrate to 58,
   * and React discards the server's markup and rebuilds the tree — a visible
   * flicker, and a warning in the console, on every page load. So the server
   * renders the absolute time instead, the first client render agrees with it, and
   * the relative figure appears once the first poll has established a clock.
   */
  const [now, setNow] = useState(null);

  /**
   * One read. Also the "Try again" button's handler, which is why it is separate
   * from the polling below.
   *
   * Three outcomes, and the difference between the last two matters:
   *
   *  * a ride -> `lastRide` and `ride` both move, and the screen stays live;
   *  * `null` -> there is no active ride. The caller decides whether that means
   *    "never had one" or "the one they had is over";
   *  * `undefined` -> the request itself failed. `error` is set and the last good
   *    ride is left alone, because "the API is briefly unreachable" is not the
   *    same as "the ride is gone".
   */
  const load = useCallback(async () => {
    try {
      const current = await getCurrentRide();

      if (current) setLastRide(current);
      setRide(current);
      setError(null);
      setNow(Date.now());

      return current;
    } catch (err) {
      setError(err);
      return undefined;
    }
  }, []);

  /**
   * Asks the API how the ride actually ended.
   *
   * Called once, and only when there was a ride and there is no longer one. The id
   * comes from the last active read, which is the only moment the id is available —
   * that is why `lastRide` exists at all.
   */
  const settleArrival = useCallback(async () => {
    if (!lastRide) return;

    setFinishing(true);
    try {
      setFinishedRide(await getRideDetail({ rideRequestId: lastRide.rideRequestId }));
    } catch (err) {
      // Not fatal: the screen still says the ride is over, just without the
      // outcome. Losing the detail must not lose the fact that it ended.
      setError(err);
    } finally {
      setFinishing(false);
    }
  }, [lastRide]);

  /**
   * The polling loop's question, and when to stop asking.
   *
   * `usePolling` owns *how* to ask — recursive timeout, hidden tab, unmount — and
   * this owns *whether to keep asking*, which is the part that differs between the
   * two screens. Here it stops on the one case that is genuinely terminal: the
   * server has no active ride for this passenger, so there is nothing left to
   * learn — the ride's own record is then read once from the other endpoint.
   *
   * A failure is not terminal: the next tick tries again.
   */
  const poll = useCallback(async () => {
    const current = await load();

    if (current === null || (current && isFinished(current.status))) {
      await settleArrival();
      return false;
    }

    return true;
  }, [load, settleArrival]);

  usePolling(poll, { intervalMs: pollIntervalMs });

  /**
   * Calls the ride off, and hands the screen to the outcome it already knows how to
   * show.
   *
   * There is no "cancelled" state to invent here. Setting `ride` to `null` is
   * enough: the screen already treats "there was a ride and there is not one" as the
   * terminal case, and `settleArrival` then reads the record that says *how* it
   * ended — which for this ride is now `CANCELLED`, with the timeline and the reason
   * beside it. The polling loop notices the null on its next tick and stops.
   *
   * A failure leaves the ride exactly where it was. The one that matters is a `409`:
   * the server refusing because a driver accepted while the passenger was choosing a
   * reason. Nothing was cancelled, and the honest response is to say so and re-read —
   * which the poll does on its own.
   */
  const onCancel = useCallback(
    async (reason) => {
      setCancelling(true);
      setCancelError(null);

      try {
        await cancelRideRequest({ rideRequestId: ride.rideRequestId, reason });
        setRide(null);
        await settleArrival();
      } catch (err) {
        setCancelError(err);
      } finally {
        setCancelling(false);
      }
    },
    [ride, settleArrival],
  );

  // "The ride ended" is derived, not stored: there was a ride, and now there is
  // not one. A passenger who never had one gets the empty state instead.
  const ended = ride === null && lastRide !== null;

  if (ended) {
    return (
      <RideEnded
        ride={finishedRide}
        lastRide={lastRide}
        loading={finishing}
        onRetry={settleArrival}
        // Paying is followed by re-reading the ride, so the timeline below gains
        // the "Ride paid" entry the settlement wrote rather than staying as it
        // was when the car stopped.
        onSettled={settleArrival}
      />
    );
  }

  if (error && !ride) {
    return (
      <ErrorState
        title="Could not load your ride"
        message={error.message}
        hint={error.isUnauthenticated ? "Your session may have ended. Sign in again." : null}
        action={
          <Button variant="secondary" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!ride) {
    return (
      <EmptyState
        title="You have no active ride"
        action={
          <LinkButton href="/ride" variant="primary">
            Request a ride
          </LinkButton>
        }
      >
        When you ask for a ride, it will appear here.
      </EmptyState>
    );
  }

  const stage = PASSENGER_STAGE[ride.stage] ?? { label: ride.stage, detail: "" };

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Your ride
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {stage.label}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{stage.detail}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <RideStatusChip status={ride.status} />
            {ride.pool ? (
              <Chip>{POOL_STATUS[ride.pool.status] ?? ride.pool.status}</Chip>
            ) : null}
          </div>
        </div>

        <Notice tone="info" className="mt-4">
          {NEXT_ACTION[ride.nextAction] ?? "Waiting for the next update."}
        </Notice>

        <Facts
          className="mt-4"
          items={[
            {
              label: "Requested",
              // Absolute until there is a client clock — see `now` above.
              value:
                now === null
                  ? formatTime(ride.requestedAt)
                  : formatElapsed(ride.requestedAt, { now }),
            },
            {
              label: "Your fare",
              value: ride.sharedFare
                ? formatMoney(ride.sharedFare.fare, ride.sharedFare.currency)
                : formatMoney(ride.soloEstimate.fare, ride.soloEstimate.currency),
            },
            {
              label: "Fare status",
              value: ride.sharedFare
                ? ride.sharedFare.finalized
                  ? "Final"
                  : "Estimate"
                : "Solo estimate",
            },
            { label: "Distance", value: formatDistance(ride.route.distanceMeters) },
            { label: "Estimated time", value: formatDuration(ride.route.durationSeconds) },
            ...(ride.passengerCount && ride.passengerCount > 1
              ? [{ label: "Sharing with", value: `${ride.passengerCount - 1} other passenger(s)` }]
              : []),
          ]}
        />
      </Panel>

      {/*
        The cancel control, offered only while the server says it may be. That flag
        is `isCancellable(status)`, which is `WAITING` — so "only if the status is
        waiting" is not restated here, it is asked for. Nothing about the ride's
        status is inspected to decide this.
      */}
      {ride.cancellable ? (
        <CancelRequest busy={cancelling} error={cancelError} onCancel={onCancel} />
      ) : null}

      <Panel>
        <Heading level={3}>Your journey</Heading>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <PlaceLine label="Pickup" point={ride.pickup} />
          <PlaceLine label="Destination" point={ride.destination} />
        </div>

        {ride.myStops?.length > 0 ? (
          <ol className="mt-5 flex flex-col gap-2">
            {ride.myStops.map((stop) => (
              <li
                key={stop.stopId}
                className="flex items-center justify-between gap-4 rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145]"
              >
                <span className="text-sm text-zinc-900 dark:text-zinc-50">
                  <span className="font-medium">
                    {stop.stopType === "PICKUP" ? "Pick up" : "Drop off"}
                  </span>{" "}
                  <span className="text-zinc-500">{stop.servicePoint.name}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-zinc-500">{STOP_STATUS[stop.status] ?? stop.status}</span>
                  {stop.actualArrivalAt ? (
                    <span className="text-xs tabular-nums text-zinc-500">
                      {formatTime(stop.actualArrivalAt)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {ride.driver || ride.vehicle ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {ride.driver ? (
              <Labeled label="Driver">
                <span className="font-medium">{ride.driver.displayName ?? "Assigned"}</span>
              </Labeled>
            ) : null}
            {ride.vehicle ? (
              <Labeled label="Vehicle">
                <span className="font-medium">{ride.vehicle.name}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {ride.vehicle.seatCapacity} seats
                </span>
              </Labeled>
            ) : null}
          </div>
        ) : null}

        {ride.memberStatus ? (
          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
            Your status: {MEMBER_STATUS[ride.memberStatus] ?? ride.memberStatus}
          </p>
        ) : null}
      </Panel>

      <Panel>
        <Heading level={3}>What has happened</Heading>
        <Timeline ride={ride} />
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          {error
            ? `Last update failed (${error.message}). Showing the last known state.`
            : `Updated ${now === null ? "—" : formatTime(new Date(now).toISOString())}. Refreshing every ${Math.round(pollIntervalMs / 1000)} seconds.`}
        </p>
      </Panel>
    </div>
  );
}

/**
 * The passenger's own instants, in order.
 *
 * Built from the timestamps the API publishes for *this* passenger — including
 * `driverArrivedAt`, which is their own pickup stop's arrival and not the pool's —
 * so nothing here can describe somebody else's part of the journey.
 */
function Timeline({ ride }) {
  const entries = [
    { label: "Ride requested", at: ride.requestedAt },
    { label: "Driver assigned", at: ride.timeline?.matchedAt },
    { label: "Driver set off", at: ride.timeline?.departedAt },
    { label: "Driver at your pickup", at: ride.timeline?.driverArrivedAt },
    { label: "You were picked up", at: ride.timeline?.pickedUpAt },
    { label: "You were dropped off", at: ride.timeline?.droppedOffAt },
  ].filter((entry) => entry.at);

  if (entries.length === 0) return <Loading label="Waiting for the first update…" />;

  return (
    <ol className="mt-4 flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-baseline justify-between gap-4 text-sm">
          <span className="text-zinc-900 dark:text-zinc-50">{entry.label}</span>
          <span className="tabular-nums text-zinc-500">{formatTime(entry.at)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The screen after the ride stops being active.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ANSWER COMES FROM
 * ---------------------------------------------------------------------------
 * `current-ride` answers with an active ride or nothing, so a ride that ends
 * arrives as `null` and that response does not say which way it ended. `ride` here
 * is the **ride detail**, fetched once from the other endpoint the moment the
 * active ride disappeared, and its `status` is the API's own `COMPLETED` or
 * `CANCELLED`.
 *
 * That ordering matters. The previous version of this component inferred
 * "completed" from the presence of a drop-off timestamp on the last *active* read —
 * an inference that was usually right and that the docs had to apologise for. A
 * passenger being told they arrived is a claim worth getting from the record.
 *
 * `lastRide` is still rendered while the detail is in flight, so the screen shows
 * the journey it knows about rather than a spinner over nothing.
 */
function RideEnded({ ride, lastRide, loading, onRetry, onSettled }) {
  const status = ride?.status ?? null;
  const completed = status === "COMPLETED";
  const cancelled = status === "CANCELLED";

  const journey = ride ?? lastRide;

  const headline = completed
    ? "You have arrived"
    : cancelled
      ? "This ride was cancelled"
      : "This ride is over";

  const copy = completed
    ? "Thanks for riding with TeslaB."
    : cancelled
      ? "The ride was cancelled before it finished."
      : "The ride is no longer active. Its outcome could not be read just now.";

  return (
    <Panel className="text-center">
      {status ? (
        <RideStatusChip status={status} />
      ) : (
        <Chip tone="stopped">{loading ? "Finishing up…" : "Ride no longer active"}</Chip>
      )}

      <h2 className="mt-3 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {headline}
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{copy}</p>

      {!ride && !loading && onRetry ? (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          Check the outcome again
        </Button>
      ) : null}

      {journey ? (
        <Facts
          className="mt-5 text-left"
          items={[
            { label: "From", value: journey.pickup.name },
            { label: "To", value: journey.destination.name },
            { label: "Requested", value: formatTime(journey.requestedAt) },
            // The *request's* own instants, not the pool's: a passenger is
            // delivered while the car may still be carrying somebody else.
            journey.completedAt
              ? { label: "Completed", value: formatTime(journey.completedAt) }
              : null,
            journey.cancelledAt
              ? { label: "Cancelled", value: formatTime(journey.cancelledAt) }
              : null,
            journey.driver?.displayName
              ? { label: "Driver", value: journey.driver.displayName }
              : null,
            journey.sharedFare
              ? {
                  label: "Fare",
                  value: formatMoney(journey.sharedFare.fare, journey.sharedFare.currency),
                }
              : null,
          ].filter(Boolean)}
        />
      ) : null}

      {ride?.timeline?.length > 0 ? (
        <div className="mt-5 text-left">
          <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            What happened
          </p>
          <ol className="mt-2 flex flex-col gap-2">
            {ride.timeline.map((entry) => (
              // `sequence` is the event's own ordinal, so two events that happen to
              // share a phase and a wording still get distinct keys.
              <li key={entry.sequence} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-zinc-900 dark:text-zinc-50">{entry.label}</span>
                <span className="tabular-nums text-zinc-500">{formatTime(entry.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/*
        The fare is settled here, at the moment the passenger is still sitting in
        the car that just stopped, rather than only on the tracking page they will
        navigate away from. `SettlePayment` renders nothing at all for a ride with
        no payment behind it -- a cancelled one, or one whose trip has not finished
        -- so a completed journey is the only case that shows a button.
      */}
      {completed && ride?.rideRequestId ? (
        <SettlePayment
          className="mt-5"
          rideRequestId={ride.rideRequestId}
          onSettled={onSettled}
        />
      ) : null}

      <div className="mt-5 flex justify-center gap-3">
        <LinkButton href="/ride" variant="primary">
          Request another ride
        </LinkButton>
      </div>
    </Panel>
  );
}
