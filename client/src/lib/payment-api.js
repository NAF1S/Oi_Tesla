import { apiFetch, apiPost } from "./api.js";

/**
 * TeslaPay: the caller's own money.
 *
 * Three calls, and every one of them answers about the signed-in user -- there
 * is no id in any path, because `/payments/me` already knows who is asking and
 * the role on the server decides whether "me" means the passenger or the driver.
 *
 * The labels live here beside the calls for the same reason they sit next to
 * every other DTO's vocabulary: they are the words this API's values have, and
 * nothing here decides anything. `payable` comes from the server, so the panel
 * below renders a Pay button from that flag rather than from `status`.
 *
 * ---------------------------------------------------------------------------
 * WHY `getMyPayments` ANSWERS AN OBJECT AND NOT AN ARRAY
 * ---------------------------------------------------------------------------
 * `apiFetch` unwraps a top-level `data` key, so a collection endpoint reaches a
 * caller as a bare array. This one is not a bare collection: it also carries
 * `side` (which side of the payment the caller is on) and `totals` (what is
 * outstanding and what has been collected). The server therefore names the list
 * `payments`, and the wrapper survives -- the same shape as `{ user }`,
 * `{ ride }` and `{ wallet }`.
 */

export const PAYMENT_METHOD = Object.freeze({
  TESLA_PAY: "TESLA_PAY",
  CASH: "CASH",
});

/** The two ways to settle, in the order they are offered. */
export const PAYMENT_METHOD_OPTIONS = Object.freeze([
  {
    value: PAYMENT_METHOD.TESLA_PAY,
    label: "TeslaPay balance",
    hint: "Taken from your balance straight away, and credited to the driver.",
  },
  {
    value: PAYMENT_METHOD.CASH,
    label: "Cash to the driver",
    hint: "Handed over in the car. Your balance does not change.",
  },
]);

export const PAYMENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
});

export const LEDGER_DIRECTION = Object.freeze({
  DEBIT: "DEBIT",
  CREDIT: "CREDIT",
});

/** What the caller owes (passenger) or is owed (driver), with their totals. */
export const getMyPayments = () => apiFetch("/payments/me");

/** The caller's balance and the movements that produced it. */
export const getMyWallet = () => apiFetch("/payments/me/wallet");

/** Settle one journey. Idempotent: settling twice returns the first outcome. */
export const payForRide = ({ rideRequestId, method }) =>
  apiPost(`/payments/rides/${rideRequestId}/pay`, { method });
