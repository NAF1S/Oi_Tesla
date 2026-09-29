"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Notice, Select } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import {
  PAYMENT_METHOD,
  PAYMENT_METHOD_OPTIONS,
  getMyPayments,
  payForRide,
} from "@/lib/payment-api";

/**
 * The Pay button for one journey.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `PaymentPanel`
 * ---------------------------------------------------------------------------
 * `PaymentPanel` is a list: everything the passenger owes, wherever they owe it.
 * This is the other half of the same job -- one journey, the one whose screen the
 * passenger is already looking at -- and it is the moment a fare is most likely to
 * be settled, because the passenger is sitting in the car that just stopped.
 *
 * So it asks the same endpoint and picks out the one row it was given an id for.
 * Selecting a row by an id the caller already has is a lookup, not a rule: nothing
 * here decides whether the payment is due or what it costs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RENDERS, AND WHY EACH CASE IS DIFFERENT
 * ---------------------------------------------------------------------------
 *  * **no payment row** -> nothing at all. A ride the passenger cancelled, or one
 *    whose trip has not finished, has no fare to settle, and an inert "Pay" button
 *    would be a claim about money that the server has not made.
 *  * **`payable`** -> the button. `payable` is the server's own answer, so this
 *    renders what the server would accept rather than a second opinion on `status`.
 *  * **settled** -> a receipt line. Worth showing: the passenger has just been in
 *    a car, and confirming that nothing is still owed is the useful thing to say.
 *
 * `onSettled` lets the screen around it react -- the tracker re-reads the ride, so
 * the timeline gains its "Ride paid" entry.
 */

/** The server's own two states, plus "not loaded yet". */
const Phase = { LOADING: "loading", NONE: "none", PAYABLE: "payable", SETTLED: "settled" };

export function SettlePayment({ rideRequestId, onSettled, className = "" }) {
  const [phase, setPhase] = useState(Phase.LOADING);
  const [payment, setPayment] = useState(null);
  const [method, setMethod] = useState(PAYMENT_METHOD.TESLA_PAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!rideRequestId) {
      setPhase(Phase.NONE);
      return;
    }

    try {
      const { payments } = await getMyPayments();
      const mine = (payments ?? []).find((row) => row.rideRequestId === rideRequestId);

      setPayment(mine ?? null);
      setPhase(!mine ? Phase.NONE : mine.payable ? Phase.PAYABLE : Phase.SETTLED);
    } catch {
      // A failed read is not "there is nothing to pay". Nothing is rendered, so
      // the passenger is not told either way -- `PaymentPanel` on the same screen
      // is where a payer goes to find out, and it has a visible error state.
      setPhase(Phase.NONE);
    }
  }, [rideRequestId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!cancelled) await load();
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await payForRide({ rideRequestId, method });

      setPayment(result.payment);
      setPhase(Phase.SETTLED);
      setNotice(
        result.settled
          ? `Paid ${formatMoney(result.payment.amount)} ${result.payment.currency} — ${result.payment.methodLabel}.`
          : "That fare was already settled.",
      );

      // The wallet balance the server returned, so the screen around this does not
      // have to re-read it to show a number it has just been handed.
      if (onSettled) await onSettled(result);
    } catch (err) {
      // `409` is the shortfall: the message names the gap in the passenger's own
      // balance, and cash is still on offer right here.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (phase === Phase.LOADING || phase === Phase.NONE) return null;

  if (phase === Phase.SETTLED) {
    return (
      <div className={className}>
        <Notice tone="success">
          {notice ??
            `Paid ${formatMoney(payment.amount)} ${payment.currency}${payment.methodLabel ? ` — ${payment.methodLabel}` : ""}.`}
        </Notice>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-left dark:border-amber-900 dark:bg-amber-950 ${className}`}
    >
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
          {formatMoney(payment.amount)} {payment.currency} to pay
        </p>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {payment.trip ? `${payment.trip.pickup} → ${payment.trip.dropoff}` : "This journey"}
        </p>
      </div>

      {error ? <Notice tone="warning">{error.message}</Notice> : null}

      <Select
        label="How would you like to pay?"
        value={method}
        onChange={(event) => setMethod(event.target.value)}
        options={PAYMENT_METHOD_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />

      <Button onClick={pay} disabled={busy} type="button">
        {busy ? "Paying…" : `Pay ${formatMoney(payment.amount)} ${payment.currency}`}
      </Button>
    </div>
  );
}
