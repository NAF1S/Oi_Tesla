/**
 * TeslaPay: settling a completed journey, and the two balances that move when it
 * is settled from the wallet.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MONEY IS ACTUALLY SAFE
 * ---------------------------------------------------------------------------
 * This module decides *when* money moves and writes the rows. It is not what
 * makes the money correct. Four things in `15-tesla-pay.sql` are:
 *
 *   * `wallet_accounts_balance_not_negative` -- an overdraft is refused by the
 *     database, so no path through this file can spend below zero;
 *   * `wallet_ledger_once_per_account` (UNIQUE `payment_id, account_id`) -- one
 *     debit and one credit per payment, so a double submit writes one entry;
 *   * the deferred `wallet_ledger_matches_balance` trigger -- the balance column
 *     must equal the ledger's sum at commit, so the two cannot drift apart;
 *   * `enforce_payment_update` -- a payment's parties and amount are frozen, and
 *     the only UPDATE it permits is PENDING -> PAID.
 *
 * Which is why this service can be read as "take the lock, check the balance,
 * write the rows" without that being the whole of the guarantee.
 *
 * ---------------------------------------------------------------------------
 * CASH MOVES NOTHING
 * ---------------------------------------------------------------------------
 * `CASH` marks the payment settled and stops. No ledger entry, no balance change,
 * because no money in this system moved -- the passenger handed notes to the
 * driver and this records that it happened. Inventing a matching debit/credit
 * pair for cash would put money in the ledger that never existed.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDER
 * ---------------------------------------------------------------------------
 * Payment -> payer wallet -> driver wallet, and nothing in this file takes a
 * ride request's lock, so it cannot deadlock against the accept/cancel paths
 * (which order request -> offer). Two passengers paying their own drivers
 * therefore contend only on their own wallets.
 */
import { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { appendRideEvent, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE } from './ride.status.js';
import {
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  canAfford,
  isPaymentMethod,
  movesMoney,
  shortfallMessage,
} from './payment.rules.js';

const { Decimal } = Prisma;

const money = (value) => new Decimal(value).toFixed(2);

/**
 * The wallet for a user, created on demand and locked for update.
 *
 * Locked because the balance is a read-modify-write: two settlements against one
 * wallet at the same moment would otherwise both read the same balance and one
 * of the two debits would be lost. `FOR UPDATE` is what serialises them.
 */
const lockWallet = async (tx, userId) => {
  await tx.$executeRawUnsafe(
    `INSERT INTO wallet_accounts (user_id)
     VALUES ($1::uuid)
     ON CONFLICT (user_id) DO NOTHING`,
    userId,
  );

  const [wallet] = await tx.$queryRawUnsafe(
    `SELECT id, user_id, balance::text AS balance, currency
       FROM wallet_accounts
      WHERE user_id = $1::uuid
      FOR UPDATE`,
    userId,
  );

  if (!wallet) throw new ApiError(500, 'Wallet account missing after ensure');
  return wallet;
};

/**
 * Moves one wallet by one entry, and records the entry.
 *
 * The balance and the ledger are written together in the caller's transaction;
 * the deferred trigger is what refuses to commit them disagreeing.
 */
const applyEntry = async (tx, { accountId, balance, paymentId, direction, amount }) => {
  const delta = direction === 'CREDIT' ? new Decimal(amount) : new Decimal(amount).negated();
  const after = new Decimal(balance).plus(delta);

  if (after.lessThan(0)) {
    // Belt and braces: the CHECK would refuse this too, but a 409 with a sentence
    // is a better answer for the caller than a constraint violation.
    throw new ApiError(409, shortfallMessage({ balance, amount }));
  }

  await tx.$executeRawUnsafe(
    `UPDATE wallet_accounts SET balance = $2::numeric, updated_at = now() WHERE id = $1::uuid`,
    accountId,
    after.toFixed(2),
  );

  await tx.$executeRawUnsafe(
    `INSERT INTO wallet_ledger (account_id, payment_id, direction, amount, balance_after)
     VALUES ($1::uuid, $2::uuid, $3::wallet_entry_direction, $4::numeric, $5::numeric)`,
    accountId,
    paymentId,
    direction,
    money(amount),
    after.toFixed(2),
  );

  return after;
};

/**
 * Creates the payment row for each passenger of a completed pool.
 *
 * Called from the trip completion transaction, so a completed trip cannot exist
 * without the debts it created. `ON CONFLICT DO NOTHING` on `ride_request_id` is
 * why this is safe to run twice: a journey is payable exactly once, and the
 * second attempt is a no-op rather than a double charge.
 *
 * The amount is the passenger's *own* allocation from the pool's calculation --
 * the figure the fare caps already bounded -- so nobody is asked to settle
 * anything other than what they were told they owed.
 */
export const createPaymentsForPool = async ({ tx, ridePoolId, now = new Date() }) => {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO payments (
       ride_request_id, ride_pool_id, fare_calculation_id,
       payer_user_id, driver_user_id, amount, currency, created_at, updated_at
     )
     SELECT rr.id, rp.id, c.id, pp.user_id, du.id, a.final_fare, a.currency, $2::timestamptz, $2::timestamptz
       FROM ride_pools rp
       JOIN LATERAL (
              SELECT * FROM pool_fare_calculations
               WHERE ride_pool_id = rp.id AND status IN ('FINALIZED', 'CURRENT')
               ORDER BY (status = 'FINALIZED') DESC, pool_version DESC
               LIMIT 1
            ) c ON true
       JOIN passenger_fare_allocations a ON a.fare_calculation_id = c.id
       JOIN ride_requests rr ON rr.id = a.ride_request_id
       JOIN passenger_profiles pp ON pp.id = rr.passenger_profile_id
       JOIN driver_profiles dp ON dp.id = rp.driver_profile_id
       JOIN users du ON du.id = dp.user_id
      WHERE rp.id = $1::uuid
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.ride_request_id = rr.id)
     RETURNING id`,
    ridePoolId,
    now,
  );

  return { created: rows.length };
};

/** The payment for one journey, with the request it belongs to, for a read. */
const loadPayment = async (tx, { rideRequestId, forUpdate = false }) => {
  const [row] = await tx.$queryRawUnsafe(
    `SELECT p.id, p.ride_request_id, p.ride_pool_id, p.amount::text AS amount, p.currency,
            p.method, p.status, p.paid_at, p.created_at,
            p.payer_user_id, p.driver_user_id,
            rr.passenger_profile_id,
            payer.name AS payer_name, driver.name AS driver_name
       FROM payments p
       JOIN ride_requests rr ON rr.id = p.ride_request_id
       JOIN users payer ON payer.id = p.payer_user_id
       JOIN users driver ON driver.id = p.driver_user_id
      WHERE p.ride_request_id = $1::uuid
      ${forUpdate ? 'FOR UPDATE OF p' : ''}`,
    rideRequestId,
  );

  return row ?? null;
};

/** The payment for one journey, as the passenger who owes it sees it. */
export const getPaymentForPassenger = async ({ passengerProfileId, rideRequestId }) => {
  const payment = await loadPayment(prisma, { rideRequestId });
  if (!payment) throw new ApiError(404, 'No payment for that ride');
  // Somebody else's payment is a 404, like every other resource here.
  if (payment.passenger_profile_id !== passengerProfileId) {
    throw new ApiError(404, 'No payment for that ride');
  }

  return payment;
};

/**
 * Settles a journey, from the wallet or in cash.
 *
 * Idempotent by outcome: a payment that is already settled is returned as it is,
 * whatever method is asked for now. The alternative -- refusing the second call
 * -- would turn a retried request into an error the client has to special-case,
 * and there is nothing for it to do differently.
 */
export const payForRide = async ({ passengerProfileId, rideRequestId, method, now = new Date() }) => {
  if (!isPaymentMethod(method)) {
    throw new ApiError(400, `method must be one of TESLA_PAY, CASH`);
  }

  return prisma.$transaction(
    async (tx) => {
      const payment = await loadPayment(tx, { rideRequestId, forUpdate: true });

      // Not found, or somebody else's journey: the same 404 for both, because a
      // distinct answer would confirm that the ride exists.
      if (!payment || payment.passenger_profile_id !== passengerProfileId) {
        throw new ApiError(404, 'No payment for that ride');
      }

      if (payment.status === PAYMENT_STATUS.PAID) {
        return { payment, wallet: null, settled: false };
      }

      // The request is locked before either wallet, so two settlements that happen
      // to share a payer and a driver take their locks in the same order and cannot
      // deadlock each other. It is also where the status the event below must
      // record comes from.
      const request = await lockRideRequest(tx, rideRequestId);

      let wallet = null;

      if (movesMoney(method)) {
        const payer = await lockWallet(tx, payment.payer_user_id);

        if (!canAfford({ balance: payer.balance, amount: payment.amount })) {
          throw new ApiError(
            409,
            shortfallMessage({ balance: payer.balance, amount: payment.amount }),
          );
        }

        const afterDebit = await applyEntry(tx, {
          accountId: payer.id,
          balance: payer.balance,
          paymentId: payment.id,
          direction: 'DEBIT',
          amount: payment.amount,
        });

        // The driver is credited in the same transaction: a settlement that
        // debited the passenger and failed to pay the driver would be money
        // taken for nothing, which the deferred trigger would refuse anyway.
        const driver = await lockWallet(tx, payment.driver_user_id);
        await applyEntry(tx, {
          accountId: driver.id,
          balance: driver.balance,
          paymentId: payment.id,
          direction: 'CREDIT',
          amount: payment.amount,
        });

        wallet = {
          id: payer.id,
          balance: afterDebit.toFixed(2),
          currency: payer.currency,
        };
      }

      const [settled] = await tx.$queryRawUnsafe(
        `UPDATE payments
            SET status = 'PAID', method = $2::payment_method, paid_at = $3::timestamptz, updated_at = $3::timestamptz
          WHERE id = $1::uuid
        RETURNING id, status, method, paid_at, amount::text AS amount, currency`,
        payment.id,
        method,
        now,
      );

      // Paying is a financial fact, not a lifecycle transition: the request was
      // already COMPLETED before this line and still is, so the event records the
      // status unchanged -- the same shape the fare-allocation events use. The
      // column is NOT NULL, so "no status" is not something that can be written.
      await appendRideEvent(tx, {
        rideRequestId,
        eventType: RIDE_EVENT_TYPE.RIDE_PAID,
        actorType: RIDE_ACTOR_TYPE.PASSENGER,
        previousStatus: request.status,
        newStatus: request.status,
        metadata: { method, amount: money(payment.amount), currency: payment.currency },
        now,
      });

      return { payment: { ...payment, ...settled }, wallet, settled: true };
    },
    { timeout: env.payment.transactionTimeoutMs },
  );
};

/** A user's TeslaPay account, with the balance the database holds. */
export const loadWalletForUser = async ({ userId }) => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO wallet_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING`,
    userId,
  );

  const [wallet] = await prisma.$queryRawUnsafe(
    `SELECT id, balance::text AS balance, currency, updated_at
       FROM wallet_accounts WHERE user_id = $1::uuid`,
    userId,
  );

  return wallet;
};

/** The most recent movements on a user's wallet, newest first. */
export const listWalletLedger = async ({ userId, limit = 20 }) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT l.id, l.direction, l.amount::text AS amount, l.balance_after::text AS balance_after,
            l.created_at, p.method, p.ride_request_id,
            counterpart.name AS counterpart_name
       FROM wallet_ledger l
       JOIN wallet_accounts w ON w.id = l.account_id
       JOIN payments p ON p.id = l.payment_id
       JOIN users counterpart
         ON counterpart.id = CASE WHEN l.direction = 'DEBIT' THEN p.driver_user_id ELSE p.payer_user_id END
      WHERE w.user_id = $1::uuid
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $2::int`,
    userId,
    limit,
  );

  return rows;
};

/**
 * The payments a user is on either side of.
 *
 * One query with the role decided by the caller's id, so a passenger sees what
 * they owe and a driver sees what they are owed without two nearly-identical
 * read paths to keep in step.
 */
export const listPaymentsForUser = async ({ userId, side, status = null, limit = 20, offset = 0 }) => {
  const column = side === 'driver' ? 'p.driver_user_id' : 'p.payer_user_id';

  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.ride_request_id, p.ride_pool_id, p.amount::text AS amount, p.currency,
            p.method, p.status, p.paid_at, p.created_at,
            payer.name AS payer_name, driver.name AS driver_name,
            rp.status AS pool_status, rp.completed_at,
            pickup.code AS pickup_code, dropoff.code AS dropoff_code
       FROM payments p
       JOIN ride_pools rp ON rp.id = p.ride_pool_id
       JOIN ride_requests rr ON rr.id = p.ride_request_id
       JOIN service_points pickup ON pickup.id = rr.pickup_service_point_id
       JOIN service_points dropoff ON dropoff.id = rr.dropoff_service_point_id
       JOIN users payer ON payer.id = p.payer_user_id
       JOIN users driver ON driver.id = p.driver_user_id
      WHERE ${column} = $1::uuid
        AND ($2::text IS NULL OR p.status::text = $2::text)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $3::int OFFSET $4::int`,
    userId,
    status,
    limit,
    offset,
  );

  const [totals] = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PENDING'), 0)::text AS outstanding,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0)::text    AS settled,
            count(*)::int AS total
       FROM payments p
      WHERE ${column} = $1::uuid`,
    userId,
  );

  return { rows, totals };
};
