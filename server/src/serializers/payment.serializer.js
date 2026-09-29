/**
 * Payment DTOs.
 *
 * Whitelists, like every other serializer here: a field is in the DTO because it
 * was chosen, not because the row had it. Nothing publishes a wallet id, an
 * internal user id or a ledger account, and the amount goes out as the exact
 * decimal **string** the column holds.
 */
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS, isOutstanding } from '../services/payment.rules.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** One payment, from either side of it. */
export const toPaymentDto = (row, { side = 'passenger' } = {}) => ({
  id: row.id,
  rideRequestId: row.ride_request_id,
  ridePoolId: row.ride_pool_id,
  amount: row.amount,
  currency: row.currency,
  status: row.status,
  method: row.method ?? null,
  methodLabel: row.method ? PAYMENT_METHOD_LABEL[row.method] : null,
  // What a screen actually branches on: `payable` is the server's answer to
  // "should there be a Pay button", so no client derives it from the status. It
  // is answerable only *for the caller*, which is why the side is passed in: the
  // driver on the other end of this same row is owed the money, not owing it, and
  // a Pay button on their screen would offer to take the fare out of their own
  // wallet.
  payable: side === 'passenger' && isOutstanding(row.status),
  settled: row.status === PAYMENT_STATUS.PAID,
  paidAt: iso(row.paid_at),
  createdAt: iso(row.created_at),
  payerName: row.payer_name ?? null,
  driverName: row.driver_name ?? null,
  ...(row.pickup_code
    ? {
        trip: {
          pickup: row.pickup_code,
          dropoff: row.dropoff_code,
          poolStatus: row.pool_status,
          completedAt: iso(row.completed_at),
        },
      }
    : {}),
});

/** The wallet, with its most recent movements. */
export const toWalletDto = ({ wallet, ledger }) => ({
  balance: wallet.balance,
  currency: wallet.currency,
  updatedAt: iso(wallet.updated_at),
  entries: ledger.map((row) => ({
    id: row.id,
    direction: row.direction,
    amount: row.amount,
    balanceAfter: row.balance_after,
    counterpartName: row.counterpart_name,
    method: row.method,
    rideRequestId: row.ride_request_id,
    createdAt: iso(row.created_at),
  })),
});
