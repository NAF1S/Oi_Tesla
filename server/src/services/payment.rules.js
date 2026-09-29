/**
 * TeslaPay as data: what a payment is, how it is settled, and which settlement
 * moves money.
 *
 * Pure. No database, no clock, no Prisma *client* -- `Prisma.Decimal` is the
 * decimal implementation the rest of the project uses for money and importing it
 * does not open a connection. So the vocabulary the service, the serializers and
 * the tests share is written down exactly once, and a rule about money is
 * reviewable in one screen.
 */
import { Prisma } from '@prisma/client';

const { Decimal } = Prisma;

/** Bumped when the settlement rules change in a way that makes old rows stale. */
export const PAYMENT_RULE_VERSION = 'tesla-pay.v1';

/**
 * How a passenger settles a completed journey.
 *
 * `TESLA_PAY` moves the balance: the payer is debited and the driver is
 * credited, in one transaction. `CASH` moves nothing -- the money changed hands
 * in the car, and this system only records that it did. That difference is the
 * whole of `movesMoney` below, and it is why the two are not symmetric.
 */
export const PAYMENT_METHOD = Object.freeze({
  TESLA_PAY: 'TESLA_PAY',
  CASH: 'CASH',
});

export const PAYMENT_METHODS = Object.freeze(Object.values(PAYMENT_METHOD));

export const PAYMENT_METHOD_LABEL = Object.freeze({
  TESLA_PAY: 'TeslaPay balance',
  CASH: 'Cash to the driver',
});

/** PENDING until the passenger chooses; PAID once they have, with a method. */
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
});

/**
 * The only transition a payment has.
 *
 * There is deliberately no FAILED and no REFUND: a settlement refused for want
 * of balance leaves the payment exactly where it was, because nothing happened.
 * Modelling a failure state would imply something to undo.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.PENDING]: Object.freeze([PAYMENT_STATUS.PAID]),
  [PAYMENT_STATUS.PAID]: Object.freeze([]),
});

export const isPaymentMethod = (value) => PAYMENT_METHODS.includes(value);

/** Whether a payment is still owed. */
export const isOutstanding = (status) => status === PAYMENT_STATUS.PENDING;

/** Whether settling this way moves money in the ledger. */
export const movesMoney = (method) => method === PAYMENT_METHOD.TESLA_PAY;

/**
 * Whether a payment may move from one status to another. Written as a function
 * over the table above so the service and the tests cannot disagree about it.
 */
export const canTransition = (from, to) =>
  (ALLOWED_TRANSITIONS[from] ?? []).includes(to);

/**
 * Whether a wallet can cover an amount.
 *
 * `balance` and `amount` are decimals or decimal strings -- never floats. The
 * comparison is inclusive: spending exactly what you have is allowed, which is
 * what the database's `balance >= 0` check permits too.
 */
export const canAfford = ({ balance, amount }) =>
  new Decimal(balance).greaterThanOrEqualTo(new Decimal(amount));

/**
 * A plain sentence for a shortfall, so a client does not compose one from two
 * numbers and cannot get the wording of "you cannot afford this" subtly wrong.
 */
export const shortfallMessage = ({ balance, amount }) => {
  const missing = new Decimal(amount).minus(new Decimal(balance));
  return `TeslaPay balance ${new Decimal(balance).toFixed(2)} does not cover ${new Decimal(amount).toFixed(2)} (short by ${missing.toFixed(2)})`;
};
