"use client";

import { useEffect, useState } from "react";

import { Button, Facts, Notice, Panel, Select } from "@/components/ui";
import { EmptyState, ErrorState, Loading } from "@/components/async-state";
import { formatMoney, formatDateTime } from "@/lib/format";
import {
  PAYMENT_METHOD,
  PAYMENT_METHOD_OPTIONS,
  getMyPayments,
  getMyWallet,
  payForRide,
} from "@/lib/payment-api";

/**
 * TeslaPay, from both sides of the same table.
 *
 * `PaymentPanel` is what a passenger sees -- what they owe, and the way to settle
 * it -- and `EarningsPanel` is the driver's view of the same payments. They share
 * this file because they share everything except the heading and which total
 * matters: both read `/payments/me`, both show the same rows, and the server
 * already decided which side the caller is on.
 *
 * One rule the panels follow, which the rest of this client follows too: nothing
 * here decides whether a payment can be settled. `payment.payable` is the
 * server's answer, so a stale screen shows a button the server will refuse with
 * a 409 and a sentence, rather than guessing and hiding something it should have
 * offered.
 */

const Heading = ({ children, hint }) => (
  <div>
    <h2 className="text-md font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      {children}
    </h2>
    {hint ? <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{hint}</p> : null}
  </div>
);

/** One payment row, rendered for whoever is looking at it. */
const PaymentRow = ({ payment, perspective }) => (
  <li className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
          {payment.trip ? `${payment.trip.pickup} → ${payment.trip.dropoff}` : "Ride"}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {perspective === "driver"
            ? `From ${payment.payerName ?? "passenger"}`
            : `To ${payment.driverName ?? "driver"}`}
          {payment.paidAt ? ` · ${formatDateTime(payment.paidAt)}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
          {formatMoney(payment.amount)} {payment.currency}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {payment.settled ? (payment.methodLabel ?? "Paid") : "Not paid yet"}
        </p>
      </div>
    </div>
  </li>
);

/**
 * The shared body: a balance, a total, and the rows.
 *
 * `busyId` rather than a single flag, so settling one journey does not disable
 * the buttons on another.
 */
function usePayments() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  // Reloading is a token rather than a function the effect calls: the effect
  // depends on a value, and the button that asks for a reload only has to change
  // it. That keeps every state update either inside the async fetch or inside an
  // event handler, which is what the lint rule about effects is protecting.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [payments, wallet] = await Promise.all([getMyPayments(), getMyWallet()]);
        if (cancelled) return;
        // `payments` is the server's wrapper: `{ side, payments, totals }`. It is
        // flattened here, once, so neither panel has to know the wire shape -- and
        // every field is defaulted, so a field that arrives missing renders an
        // empty panel rather than throwing inside a component.
        setState({
          loading: false,
          error: null,
          data: {
            side: payments.side,
            rows: payments.payments ?? [],
            totals: payments.totals ?? { outstanding: "0.00", settled: "0.00", total: 0 },
            wallet: wallet.wallet,
          },
        });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err, data: null });
      }
    })();

    // An unmount or a reload must not land a stale answer on the new state.
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { ...state, reload: () => setReloadToken((token) => token + 1) };
}

/** The balance line, which both panels show because both have a wallet. */
const Balance = ({ wallet }) => (
  <Facts
    items={[
      {
        label: "TeslaPay balance",
        value: `${formatMoney(wallet.balance)} ${wallet.currency}`,
      },
    ]}
  />
);

/** A passenger: what is still owed, and how to settle it. */
export function PaymentPanel() {
  const { loading, error, data, reload } = usePayments();
  const [choice, setChoice] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [payError, setPayError] = useState(null);
  const [notice, setNotice] = useState(null);

  const settle = async (payment) => {
    const method = choice[payment.id] ?? PAYMENT_METHOD.TESLA_PAY;
    setBusyId(payment.id);
    setPayError(null);
    setNotice(null);

    try {
      const result = await payForRide({ rideRequestId: payment.rideRequestId, method });
      setNotice(
        result.settled
          ? `${formatMoney(result.payment.amount)} ${result.payment.currency} paid — ${result.payment.methodLabel}.`
          : "That ride was already settled.",
      );
      await reload();
    } catch (err) {
      // A shortfall is an ordinary answer, not a failure of the app: the message
      // names the gap and the passenger can simply choose cash instead.
      setPayError(err);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Loading label="Loading your payments" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const outstanding = data.rows.filter((payment) => payment.payable);

  return (
    <Panel className="flex flex-col gap-4">
      <Heading hint="Settle a completed ride from your balance, or in cash.">TeslaPay</Heading>
      <Balance wallet={data.wallet} />

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {payError ? <Notice tone="warning">{payError.message}</Notice> : null}

      {outstanding.length === 0 ? (
        <EmptyState
          title="Nothing to pay"
          description="Completed rides that still need settling will appear here."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {outstanding.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950"
            >
              <PaymentRow payment={payment} perspective="passenger" />
              <Select
                label="How would you like to pay?"
                value={choice[payment.id] ?? PAYMENT_METHOD.TESLA_PAY}
                onChange={(event) =>
                  setChoice((current) => ({ ...current, [payment.id]: event.target.value }))
                }
                options={PAYMENT_METHOD_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
              <Button
                onClick={() => settle(payment)}
                disabled={busyId === payment.id}
                type="button"
              >
                {busyId === payment.id
                  ? "Settling…"
                  : `Pay ${formatMoney(payment.amount)} ${payment.currency}`}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {data.rows.length > outstanding.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
            Already settled ({data.rows.length - outstanding.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {data.rows
              .filter((payment) => !payment.payable)
              .map((payment) => (
                <PaymentRow key={payment.id} payment={payment} perspective="passenger" />
              ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

/** A driver: what the fares have earned, and what is still owed to them. */
export function EarningsPanel() {
  const { loading, error, data, reload } = usePayments();

  if (loading) return <Loading label="Loading your earnings" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const outstanding = data.rows.filter((payment) => payment.payable);

  return (
    <Panel className="flex flex-col gap-4">
      <Heading hint="Fares you have collected, and fares still owed to you.">Earnings</Heading>

      <Facts
        items={[
          {
            label: "TeslaPay balance",
            value: `${formatMoney(data.wallet.balance)} ${data.wallet.currency}`,
          },
          {
            label: "Outstanding",
            value: `${formatMoney(data.totals.outstanding)} ${data.wallet.currency}`,
          },
          {
            label: "Collected",
            value: `${formatMoney(data.totals.settled)} ${data.wallet.currency}`,
          },
        ]}
      />

      {data.rows.length === 0 ? (
        <EmptyState
          title="No fares yet"
          description="When you finish a trip, what each passenger owes appears here."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.rows.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} perspective="driver" />
          ))}
        </ul>
      )}

      {outstanding.length > 0 ? (
        <Notice tone="info">
          {outstanding.length === 1
            ? "One passenger has not settled yet."
            : `${outstanding.length} passengers have not settled yet.`}{" "}
          Cash fares are marked as paid by the passenger.
        </Notice>
      ) : null}
    </Panel>
  );
}
