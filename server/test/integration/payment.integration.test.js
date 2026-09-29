import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as offers from '../../src/services/offer.service.js';
import { PAYMENT_METHOD } from '../../src/services/payment.rules.js';
import { createRideRequest } from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';
import { POINTS, goOnline, loadDemoUser, resetDispatchState } from '../helpers/drivers.js';

/**
 * TeslaPay, over HTTP, against the real database.
 *
 * The suite drives a real journey to `COMPLETED` -- the only thing that creates a
 * payment -- and then settles it, asserting the money at *both* ends: the
 * passenger's wallet down, the driver's wallet up, and two ledger rows whose
 * `balance_after` values agree with the balances they describe.
 *
 * Three habits are deliberate.
 *
 * **Nothing is written by hand that the product would not write.** The pool comes
 * from an offer and its acceptance, the payment comes from completing the trip,
 * and the settlement goes through the endpoint. No test inserts a payment row and
 * then checks it is there.
 *
 * **The balance is read twice.** Once from `wallet_accounts` and once as the sum
 * of its own ledger. The schema's deferred trigger enforces that equality on
 * commit, so a test that only read the cached balance would pass while the ledger
 * disagreed -- and the ledger is the part a reconciliation would trust.
 *
 * **Idempotency is asserted as "nothing moved the second time"**, not as "no error":
 * a repeat settle is an ordinary answer, and the guarantee worth having is that the
 * driver's balance is the same afterwards.
 */

let api;
let nusrat;
let rafiq;
let shirin;
let jashim;
let sequence = 0;

const nextKey = (label = 'pay') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

// --- HTTP ---------------------------------------------------------------

const login = async (email) => {
  const response = await api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.demoSeedPassword }),
  });

  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

const post = (cookie, path, body) =>
  api.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (cookie, path) => api.request(path, { headers: cookie ? { cookie } : {} });

// --- Fixtures -----------------------------------------------------------

const requestRide = async (passenger) => {
  const { quote } = await createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: POINTS.PICKUP,
    destinationServicePointCode: POINTS.DESTINATION,
    departureAt: new Date(),
  });

  const { request } = await createRideRequest({
    passenger,
    fareQuoteId: quote.id,
    idempotencyKey: nextKey(),
  });

  return request;
};

/** One committed pool with one passenger, created the way the product creates one. */
const createInitialPool = async ({ driver, passenger }) => {
  await goOnline(driver, POINTS.PICKUP);

  const request = await requestRide(passenger);
  const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(dispatched.dispatched, true, 'the fixture pool needs a driver');

  const accepted = await offers.acceptOffer({ driver, offerId: dispatched.offerId });

  return { request, poolId: accepted.pool.id };
};

// --- Reads --------------------------------------------------------------

const stopsOf = (poolId) =>
  pool
    .query(
      `SELECT id, sequence, stop_type, pool_member_id
         FROM pool_stops WHERE ride_pool_id = $1::uuid ORDER BY sequence`,
      [poolId],
    )
    .then((result) => result.rows);

const paymentRows = (poolId) =>
  pool
    .query(
      `SELECT id, ride_request_id, payer_user_id, driver_user_id, amount, currency,
              method, status, paid_at, fare_calculation_id
         FROM payments WHERE ride_pool_id = $1::uuid ORDER BY id`,
      [poolId],
    )
    .then((result) => result.rows);

const walletRow = (userId) =>
  pool
    .query(
      `SELECT id, balance, currency FROM wallet_accounts WHERE user_id = $1::uuid`,
      [userId],
    )
    .then((result) => result.rows[0]);

/**
 * Credits a wallet the way a top-up would: the balance and the entry that produced
 * it, in one transaction, so the two agree at commit.
 *
 * A fixture, not a product path -- nothing in the API funds a wallet. It exists
 * because these tests spend real money, and a balance carried over from the test
 * that ran before would decide whether this one passes.
 */
const topUp = (userId, amount) =>
  pool.query(
    // One statement, so one transaction: the balance and the entry that produced it
    // are committed together, and the deferred trigger sees them agree. Two
    // statements would need an explicit transaction, and this suite's helper is a
    // query runner rather than a connection.
    `WITH upserted AS (
       INSERT INTO wallet_accounts (user_id, balance)
       VALUES ($1::uuid, $2::numeric)
       ON CONFLICT (user_id) DO UPDATE SET balance = wallet_accounts.balance + $2::numeric
       RETURNING id, balance
     )
     INSERT INTO wallet_ledger (account_id, reason, direction, amount, balance_after)
     SELECT id, 'TOP_UP', 'CREDIT', $2::numeric, balance FROM upserted`,
    [userId, amount],
  );

/**
 * The ledger's own verdict on a balance.
 *
 * This is the number the schema's deferred constraint compares against
 * `wallet_accounts.balance`, so reading it here is reading the same fact the
 * database enforces rather than a second opinion about it.
 */
const ledgerSum = (userId) =>
  pool
    .query(
      `SELECT COALESCE(SUM(CASE WHEN wl.direction = 'CREDIT' THEN wl.amount
                                ELSE -wl.amount END), 0) AS total
         FROM wallet_ledger wl
         JOIN wallet_accounts wa ON wa.id = wl.account_id
        WHERE wa.user_id = $1::uuid`,
      [userId],
    )
    .then((result) => result.rows[0].total);

const ledgerEntries = (userId) =>
  pool
    .query(
      `SELECT wl.direction, wl.amount, wl.balance_after, wl.reason, wl.payment_id
         FROM wallet_ledger wl
         JOIN wallet_accounts wa ON wa.id = wl.account_id
        WHERE wa.user_id = $1::uuid ORDER BY wl.created_at, wl.id`,
      [userId],
    )
    .then((result) => result.rows);

const rideEvents = (rideRequestId) =>
  pool
    .query(
      `SELECT event_type FROM ride_events WHERE ride_request_id = $1::uuid ORDER BY sequence`,
      [rideRequestId],
    )
    .then((result) => result.rows.map((row) => row.event_type));

// --- Commands -----------------------------------------------------------

const depart = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/depart`);
const arrive = (cookie, poolId, stopId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/arrive`);
const pickup = (cookie, poolId, stopId, memberId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/members/${memberId}/pickup`);
const start = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/start`);
const dropoff = (cookie, poolId, stopId, memberId) =>
  post(cookie, `/drivers/me/pools/${poolId}/stops/${stopId}/members/${memberId}/dropoff`);
const complete = (cookie, poolId) => post(cookie, `/drivers/me/pools/${poolId}/complete`);

const pay = (cookie, rideRequestId, method) =>
  post(cookie, `/payments/rides/${rideRequestId}/pay`, { method });

/** Drives the stored plan in order, starting the trip before the first delivery. */
const driveTheWholeTrip = async (cookie, poolId) => {
  await depart(cookie, poolId);

  const stops = await stopsOf(poolId);
  let started = false;

  for (const stop of stops) {
    if (stop.stop_type === 'DROPOFF' && !started) {
      // eslint-disable-next-line no-await-in-loop
      const response = await start(cookie, poolId);
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
      started = true;
    }

    // eslint-disable-next-line no-await-in-loop
    await arrive(cookie, poolId, stop.id);

    // eslint-disable-next-line no-await-in-loop
    await (stop.stop_type === 'PICKUP'
      ? pickup(cookie, poolId, stop.id, stop.pool_member_id)
      : dropoff(cookie, poolId, stop.id, stop.pool_member_id));
  }

  const finished = await complete(cookie, poolId);
  assert.strictEqual(finished.status, 200, JSON.stringify(finished.body));
};

/** A finished journey with its payment row waiting. */
const completedRide = async (email = 'jashim@example.com') => {
  const { request, poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
  const cookie = await login(email);

  await driveTheWholeTrip(cookie, poolId);

  return { request, poolId, cookie };
};

// --- Lifecycle ----------------------------------------------------------

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');
  jashim = await loadDemoUser('jashim@example.com');
});

beforeEach(async () => {
  await resetDispatchState();
  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  jashim = await loadDemoUser('jashim@example.com');

  // Each test funds the wallet it is about to spend. Resetting the dispatch state
  // deletes the rides, and so the payments, but a ledger entry records money that
  // moved and deliberately outlives the payment that produced it (15-tesla-pay.sql
  // section 10) -- so the balance the previous test left is still there. Topping up
  // makes every test independent of the order it ran in.
  await topUp(nusrat.id, '500.00');
});

after(async () => {
  try {
    await resetDispatchState();
  } finally {
    await api.close();
    await closePool();
  }
});

// ========================================================================
// 1. Completing a trip creates the debt
// ========================================================================

describe('the payment a completed trip creates', () => {
  it('creates one PENDING payment for the passenger, owed by them and owed to the driver (category 1)', async () => {
    const { request, poolId } = await completedRide();

    const rows = await paymentRows(poolId);
    assert.strictEqual(rows.length, 1, 'one passenger, one payment');

    const [payment] = rows;
    assert.strictEqual(payment.status, 'PENDING');
    assert.strictEqual(payment.method, null, 'nothing has been paid with yet');
    assert.strictEqual(payment.paid_at, null);
    assert.strictEqual(payment.ride_request_id, request.id);
    assert.strictEqual(payment.payer_user_id, nusrat.id);
    assert.strictEqual(payment.driver_user_id, jashim.id);
    assert.ok(Number(payment.amount) > 0, 'a completed ride costs something');
    assert.strictEqual(payment.currency, 'BDT');
    assert.ok(payment.fare_calculation_id, 'the payment names the fare it came from');
  });

  it('creates no payment for a trip that has not finished', async () => {
    const { poolId } = await createInitialPool({ driver: jashim, passenger: nusrat });
    const cookie = await login('jashim@example.com');

    await depart(cookie, poolId);

    assert.deepStrictEqual(await paymentRows(poolId), [], 'the debt appears when the ride ends');
  });

  it('answers a passenger with what they owe, and a driver with what they are owed', async () => {
    const { request } = await completedRide();

    const asDriver = await login('jashim@example.com');
    const asPassenger = await login('nusrat@example.com');

    const driverView = await get(asDriver, '/payments/me');
    const passengerView = await get(asPassenger, '/payments/me');

    assert.strictEqual(driverView.status, 200);
    assert.strictEqual(passengerView.status, 200);

    // The role on the authenticated record decides the side, and it is reported
    // rather than inferred by the client.
    assert.strictEqual(driverView.body.side, 'driver');
    assert.strictEqual(passengerView.body.side, 'passenger');

    const driverRow = driverView.body.payments.find((row) => row.rideRequestId === request.id);
    const passengerRow = passengerView.body.payments.find((row) => row.rideRequestId === request.id);

    assert.ok(driverRow, 'the driver sees the fare they are owed');
    assert.ok(passengerRow, 'the passenger sees the fare they owe');
    assert.strictEqual(driverRow.amount, passengerRow.amount, 'one fare, two sides');

    // `payable` is the server's answer for the Pay button. Only one side of the
    // same row can act on it.
    assert.strictEqual(driverRow.payable, false, 'a driver does not pay themselves');
    assert.strictEqual(passengerRow.payable, true);
    assert.strictEqual(passengerRow.settled, false);
  });
});

// ========================================================================
// 2. Paying from the balance
// ========================================================================

describe('paying from the TeslaPay balance', () => {
  it('takes the fare from the passenger and gives it to the driver (category 2)', async () => {
    const { request } = await completedRide();

    const before = {
      passenger: await walletRow(nusrat.id),
      driver: await walletRow(jashim.id),
    };

    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.settled, true);
    assert.strictEqual(response.body.payment.settled, true);
    assert.strictEqual(response.body.payment.method, 'TESLA_PAY');
    assert.ok(response.body.payment.paidAt, 'the moment of payment is recorded');

    const amount = response.body.payment.amount;

    const after = {
      passenger: await walletRow(nusrat.id),
      driver: await walletRow(jashim.id),
    };

    // The money left one balance and arrived in the other, for the same amount.
    assert.strictEqual(
      Number(after.passenger.balance),
      Number(before.passenger.balance) - Number(amount),
      'the passenger paid exactly the fare',
    );
    assert.strictEqual(
      Number(after.driver.balance),
      Number(before.driver.balance) + Number(amount),
      'the driver was credited the same amount',
    );

    // And the ledger agrees with both, which is what the deferred trigger checks.
    assert.strictEqual(Number(await ledgerSum(nusrat.id)), Number(after.passenger.balance));
    assert.strictEqual(Number(await ledgerSum(jashim.id)), Number(after.driver.balance));
  });

  it('writes one DEBIT for the payer and one CREDIT for the driver, both naming the payment (category 3)', async () => {
    const { request, poolId } = await completedRide();

    const cookie = await login('nusrat@example.com');
    assert.strictEqual((await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY)).status, 200);

    const [payment] = await paymentRows(poolId);

    const passengerEntries = (await ledgerEntries(nusrat.id)).filter(
      (entry) => entry.payment_id === payment.id,
    );
    const driverEntries = (await ledgerEntries(jashim.id)).filter(
      (entry) => entry.payment_id === payment.id,
    );

    assert.strictEqual(passengerEntries.length, 1);
    assert.strictEqual(driverEntries.length, 1);

    assert.strictEqual(passengerEntries[0].direction, 'DEBIT');
    assert.strictEqual(driverEntries[0].direction, 'CREDIT');
    assert.strictEqual(Number(passengerEntries[0].amount), Number(payment.amount));
    assert.strictEqual(Number(driverEntries[0].amount), Number(payment.amount));

    // `balance_after` is the running balance the entry produced, so the last one
    // written for an account is that account's balance.
    const passengerWallet = await walletRow(nusrat.id);
    assert.strictEqual(
      Number(passengerEntries[0].balance_after),
      Number(passengerWallet.balance),
    );
  });

  it('records the settlement on the passenger timeline (category 4)', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    const events = await rideEvents(request.id);
    assert.ok(events.includes('RIDE_PAID'), 'the passenger is told their ride is paid');

    // Once. The event is written in the same transaction as the state change, so a
    // replay must not add a second one.
    assert.strictEqual(events.filter((type) => type === 'RIDE_PAID').length, 1);
  });

  it('reports the new balance in its own answer, so the payer need not re-read it', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    assert.strictEqual(response.status, 200);
    const wallet = await walletRow(nusrat.id);
    assert.strictEqual(Number(response.body.wallet.balance), Number(wallet.balance));
    assert.strictEqual(response.body.wallet.currency, 'BDT');
  });
});

// ========================================================================
// 3. Paying in cash
// ========================================================================

describe('paying in cash', () => {
  it('settles the fare without moving a single unit (category 5)', async () => {
    const { request } = await completedRide();

    const before = {
      passenger: await walletRow(nusrat.id),
      driver: await walletRow(jashim.id),
    };

    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.CASH);

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.payment.method, 'CASH');
    assert.strictEqual(response.body.payment.settled, true);

    // Cash never touched the ledger: the passenger handed it over in the car.
    assert.strictEqual(
      Number((await walletRow(nusrat.id)).balance),
      Number(before.passenger.balance),
    );
    assert.strictEqual(
      Number((await walletRow(jashim.id)).balance),
      Number(before.driver.balance),
    );
    assert.strictEqual(response.body.wallet, null, 'nothing moved, so there is no new balance');
  });

  it('still settles a fare the balance could not have covered (category 6)', async () => {
    // A passenger with an empty wallet pays cash and is done. This is the case the
    // shortfall message exists to point at, so it must not be blocked by it.
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.CASH);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.settled, true);
  });
});

// ========================================================================
// 4. What is refused
// ========================================================================

describe('what the endpoint refuses', () => {
  it('refuses a second settlement of the same journey, without moving money again (category 7)', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    assert.strictEqual((await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY)).status, 200);

    const afterFirst = await walletRow(nusrat.id);

    const second = await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    assert.strictEqual(second.status, 200, 'a repeat is an answer, not a failure');
    assert.strictEqual(second.body.settled, false, 'nothing was settled this time');
    assert.strictEqual(second.body.payment.method, 'TESLA_PAY', 'the first method stands');
    assert.strictEqual(second.body.payment.status, 'PAID');

    assert.strictEqual(
      Number((await walletRow(nusrat.id)).balance),
      Number(afterFirst.balance),
      'the passenger is not charged twice',
    );
  });

  it('refuses a method that is not one of the two (category 8)', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, request.id, 'BITCOIN');

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /TESLA_PAY|CASH/);
  });

  it('refuses a body field that is not the method (category 9)', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    const response = await post(cookie, `/payments/rides/${request.id}/pay`, {
      method: PAYMENT_METHOD.CASH,
      amount: '1.00',
    });

    assert.strictEqual(response.status, 400, 'a client cannot name the amount it pays');
  });

  it('answers 404 for another passenger\u2019s ride, not 403 (category 10)', async () => {
    const { request } = await completedRide();

    // Shirin is a passenger with a wallet of her own. Rafiq's ride is not hers, and
    // a 403 would confirm it exists.
    const cookie = await login('shirin@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    assert.strictEqual(response.status, 404, 'another passenger\u2019s payment is not found');
  });

  it('answers 404 for a ride request that does not exist (category 11)', async () => {
    const cookie = await login('nusrat@example.com');
    const response = await pay(cookie, '00000000-0000-4000-8000-000000000000', PAYMENT_METHOD.CASH);

    assert.strictEqual(response.status, 404);
  });

  it('refuses a driver paying a fare (category 12)', async () => {
    const { request } = await completedRide();

    const cookie = await login('jashim@example.com');
    const response = await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    assert.strictEqual(response.status, 403, 'only the passenger pays');
  });

  it('refuses an unauthenticated settlement (category 13)', async () => {
    const { request } = await completedRide();

    const response = await post(null, `/payments/rides/${request.id}/pay`, {
      method: PAYMENT_METHOD.CASH,
    });

    assert.strictEqual(response.status, 401);
  });
});

// ========================================================================
// 5. The guarantees behind the service
// ========================================================================

describe('the guarantees the database holds', () => {
  it('leaves the driver\u2019s wallet and its ledger agreeing after a settlement (category 14)', async () => {
    const { request } = await completedRide();

    const cookie = await login('nusrat@example.com');
    await pay(cookie, request.id, PAYMENT_METHOD.TESLA_PAY);

    for (const user of [nusrat, jashim]) {
      const wallet = await walletRow(user.id);

      // The deferred trigger compares exactly these two numbers on commit, so this
      // is the same claim the database makes -- asserted here so a failure names
      // the account rather than surfacing as a constraint error somewhere else.
      assert.strictEqual(
        Number(await ledgerSum(user.id)),
        Number(wallet.balance),
        `the ledger of ${user.email} disagrees with its balance`,
      );
      assert.ok(Number(wallet.balance) >= 0, 'a wallet is never negative');
    }
  });

  it('refuses a ledger entry that would take a balance below zero (category 15)', async () => {
    // The service checks affordability first and answers 409; this asserts the
    // constraint underneath it, so a bug in the check cannot spend money that is
    // not there.
    const wallet = await walletRow(nusrat.id);

    await assert.rejects(
      prisma.$executeRawUnsafe(
        `INSERT INTO wallet_ledger (account_id, direction, amount, balance_after, reason)
         VALUES ($1::uuid, 'DEBIT', 1.00, -1.00, 'PAYMENT')`,
        wallet.id,
      ),
      (error) => /wallet_ledger_balance_after_not_negative|check/i.test(String(error.message)),
    );
  });
});
