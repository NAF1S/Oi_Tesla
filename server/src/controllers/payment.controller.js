/**
 * TeslaPay endpoints.
 *
 * The caller's own identity decides which side of a payment they are on and
 * which wallet is theirs: `/payments/me` answers "what do I owe" to a passenger
 * and "what am I owed" to a driver, from one handler, because the role is on the
 * authenticated record rather than in the query. No path or body names a user.
 *
 * Status codes:
 *   200 - the payment, the wallet, or a settlement (including a repeat of one)
 *   400 - an unknown method, or a body field that is not `method`
 *   401 - no valid authentication
 *   403 - authenticated, but not a passenger (only a passenger pays)
 *   404 - no such payment for this caller
 *   409 - the wallet cannot cover it
 */
import { Role } from '@prisma/client';

import { currentUser, requirePassengerProfileId } from '../middleware/auth.js';
import * as dto from '../serializers/payment.serializer.js';
import * as payment from '../services/payment.service.js';
import { assertBodyKeys } from '../utils/validation.js';

const PAY_BODY_KEYS = ['method'];

/** The payments this caller is on either side of, plus their totals. */
export const listMyPayments = async (req, res) => {
  const user = currentUser(req);
  const side = user.role === Role.DRIVER ? 'driver' : 'passenger';

  const { rows, totals } = await payment.listPaymentsForUser({ userId: user.id, side });

  // The list is named, not `data`. `data` is the key the client's fetch wrapper
  // unwraps -- and discards every sibling of -- which is right when the whole
  // response *is* the list (`{ data, pagination }`) and wrong here, where `side`
  // and `totals` are half the point of the call. A named wrapper is the same
  // shape `/auth/me` uses for `{ user }` and the wallet uses for `{ wallet }`.
  res.json({
    side,
    payments: rows.map((row) => dto.toPaymentDto(row, { side })),
    totals: {
      outstanding: totals.outstanding,
      settled: totals.settled,
      total: totals.total,
    },
  });
};

/** This caller's TeslaPay balance, and the movements that produced it. */
export const getMyWallet = async (req, res) => {
  const user = currentUser(req);

  const [wallet, ledger] = await Promise.all([
    payment.loadWalletForUser({ userId: user.id }),
    payment.listWalletLedger({ userId: user.id }),
  ]);

  res.json({ wallet: dto.toWalletDto({ wallet, ledger }) });
};

/** Settle one journey, from the balance or in cash. */
export const payForRide = async (req, res) => {
  assertBodyKeys(req.body, PAY_BODY_KEYS);

  const result = await payment.payForRide({
    passengerProfileId: requirePassengerProfileId(currentUser(req)),
    rideRequestId: req.params.rideRequestId,
    method: req.body?.method,
  });

  res.json({
    payment: dto.toPaymentDto(result.payment),
    // The balance after paying, so the caller does not have to re-read the wallet
    // to update a number it is already showing. Null for cash, and for a repeat:
    // nothing moved, so there is no new balance to report.
    wallet: result.wallet
      ? { balance: result.wallet.balance, currency: result.wallet.currency }
      : null,
    settled: result.settled,
  });
};
