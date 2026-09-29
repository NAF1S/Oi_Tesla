import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { env } from '../../src/config/env.js';
import { isQuoteExpired } from '../../src/services/fare.calculator.js';
import * as fareService from '../../src/services/fare.service.js';
import * as routing from '../../src/services/routing.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, expectPgError, pool, prepareDatabase, withRollback } from '../helpers/db.js';

/**
 * End-to-end tests for POST /api/fare-quotes, driven through the real Express app
 * over HTTP against the real database and the real routing service.
 *
 * Two things make these tests trustworthy rather than tautological:
 *
 *   1. **Fixed instants.** Rush hour and off-peak are asserted with 08:41 and
 *      12:00 in Dhaka, never with the current clock, so a run at any hour
 *      produces the same fares.
 *   2. **An independent oracle.** `expectedFare` below re-implements the
 *      documented formula in the test file using its own Decimal arithmetic, on
 *      inputs it loads itself from the graph, the policy table and the routing
 *      service. When the endpoint's numbers match it, the implementation agrees
 *      with the specification rather than with itself.
 */

const ORIGIN = 'banani-road-11';
const DESTINATION = 'mohakhali-bus-terminal';
/** The cheapest seeded pair: a single 445 m intra-zone edge, below the floor. */
const SHORT_ORIGIN = 'banani-road-11';
const SHORT_DESTINATION = 'banani-kakoli';

/** 08:41 in Dhaka -- inside the 07:30-10:30 morning peak. */
const RUSH_HOUR_DEPARTURE = '2026-09-24T08:41:00+06:00';
/** 12:00 in Dhaka -- between the two peaks. */
const NORMAL_DEPARTURE = '2026-09-24T12:00:00+06:00';

/** The traversed edge between ORIGIN and DESTINATION, weighted 1.5 in the seed. */
const WEIGHTED_EDGE = 'edge-mohakhali-bus-terminal-to-banani-road-11';

const QUOTE_KEYS = [
  'departureAt',
  'destination',
  'estimatedArrivalAt',
  'expiresAt',
  'fare',
  'origin',
  'quoteId',
  'route',
  'trafficProfile',
];

const MONEY_FIELDS = [
  'baseFare',
  'distanceFare',
  'timeFare',
  'preTrafficSubtotal',
  'trafficMultiplier',
  'trafficAdjustment',
  'unroundedFare',
  'fareRoundingAdjustment',
  'finalFare',
];

/** The money that is a component of the fare rather than the price of it. */
const COMPONENT_FIELDS = MONEY_FIELDS.filter((field) => field !== 'finalFare');

let api;
let authCookie = null;

const jsonPost = (body, cookie) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});

const login = async (email) => {
  const response = await api.request(
    '/auth/login',
    jsonPost({ email, password: env.demoSeedPassword }, null),
  );
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

const quoteAs = (body, cookie) => api.request('/fare-quotes', jsonPost(body, cookie));

const quote = (body) => quoteAs(body, authCookie);

const quoteOk = async (body, expectedStatus = 201) => {
  const response = await quote(body);
  assert.strictEqual(response.status, expectedStatus, JSON.stringify(response.body));
  return response.body;
};

const request = (overrides = {}) => ({
  originServicePointCode: ORIGIN,
  destinationServicePointCode: DESTINATION,
  departureAt: RUSH_HOUR_DEPARTURE,
  ...overrides,
});

/**
 * The documented fare formula, implemented independently of the service.
 *
 * Everything it uses it loads itself: the route from the routing service, the
 * policy from the policy table, the weights from the graph.
 */
const expectedFare = async ({ originServicePointCode, destinationServicePointCode, departureAt }) => {
  const at = new Date(departureAt);
  const route = await routing.estimateRoute({
    originServicePointCode,
    destinationServicePointCode,
    departureAt: at,
  });

  const policy = await pool.farePolicy.findFirst({
    where: {
      code: env.fare.pricingCode,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
  });
  assert.ok(policy, 'the oracle needs an effective policy');

  const weighted = await pool.routingEdge.findMany({
    where: { code: { in: route.legs.map((leg) => leg.edgeCode) } },
    select: { code: true, fareWeight: true },
  });
  const weightByCode = new Map(weighted.map((edge) => [edge.code, edge.fareWeight]));

  const scale = policy.roundingScale;
  const round = (value) => value.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
  const baseFare = round(policy.baseFare);
  const minimumFare = round(policy.minimumFare);

  let distanceFare = new Prisma.Decimal(0);
  for (const leg of route.legs) {
    const kilometers = new Prisma.Decimal(leg.distanceMeters).div(1000);
    distanceFare = distanceFare.plus(
      round(kilometers.times(policy.perKilometerRate).times(weightByCode.get(leg.edgeCode))),
    );
  }

  const durationMinutes = new Prisma.Decimal(route.durationSeconds).div(60);
  const timeFare = round(durationMinutes.times(policy.perMinuteRate));
  const preTrafficSubtotal = baseFare.plus(distanceFare).plus(timeFare);

  const trafficMultiplier =
    route.trafficProfile === 'RUSH_HOUR' ? policy.rushHourMultiplier : policy.normalTrafficMultiplier;
  const trafficAdjustment = round(preTrafficSubtotal.times(trafficMultiplier.minus(1)));
  const trafficAdjustedFare = preTrafficSubtotal.plus(trafficAdjustment);

  // The last step: the protected fare snapped to a whole number of the policy's
  // unit, with the difference recorded rather than lost.
  const unroundedFare = Prisma.Decimal.max(minimumFare, trafficAdjustedFare);
  const finalFare = unroundedFare
    .div(policy.fareRoundingUnit)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .times(policy.fareRoundingUnit);

  return {
    route,
    policy,
    baseFare: baseFare.toFixed(scale),
    distanceFare: distanceFare.toFixed(scale),
    timeFare: timeFare.toFixed(scale),
    preTrafficSubtotal: preTrafficSubtotal.toFixed(scale),
    trafficMultiplier: trafficMultiplier.toFixed(2),
    trafficAdjustment: trafficAdjustment.toFixed(scale),
    unroundedFare: unroundedFare.toFixed(scale),
    fareRoundingAdjustment: finalFare.minus(unroundedFare).toFixed(scale),
    finalFare: finalFare.toFixed(0),
    minimumFare: minimumFare.toFixed(scale),
    minimumFareApplied: minimumFare.greaterThan(trafficAdjustedFare),
    durationMinutes: durationMinutes.toFixed(2),
  };
};

/** The stored row for a quote the API just returned. */
const storedQuote = (quoteId) => pool.fareQuote.findUnique({ where: { id: quoteId } });

before(async () => {
  await prepareDatabase();
  api = await startApiServer();
  authCookie = await login('nusrat@example.com');
});

after(async () => {
  await api?.close();
  await closePool();
});

describe('authentication', () => {
  it('rejects an unauthenticated quote with 401', async () => {
    const response = await quoteAs(request(), null);

    assert.strictEqual(response.status, 401);
    assert.match(response.body.error.message, /Authentication required/);
  });

  it('rejects a malformed or tampered session cookie', async () => {
    for (const cookie of ['teslab_auth=not-a-token', `${authCookie.slice(0, -1)}z`]) {
      const response = await quoteAs(request(), cookie);
      assert.strictEqual(response.status, 401);
    }
  });

  it('answers an authenticated request', async () => {
    const response = await quoteAs(request(), authCookie);
    assert.strictEqual(response.status, 201);
  });

  it('refuses a driver, because a quote is now a passenger?s committed request', async () => {
    // Ownership arrived with ride requests: a quote is accepted by exactly the
    // passenger who owns it, so quoting is a passenger operation. A driver is
    // told no rather than served a quote nobody could use.
    const driverCookie = await login('jashim@example.com');
    const response = await quoteAs(request(), driverCookie);

    assert.strictEqual(response.status, 403);
    assert.match(response.body.error.message, /do not have access/i);
  });
});

describe('POST /api/fare-quotes', () => {
  it('quotes Banani Road 11 to Mohakhali Bus Terminal in BDT', async () => {
    const body = await quoteOk(request());
    const expected = await expectedFare(request());

    assert.strictEqual(body.quoteId.length, 36);
    assert.deepStrictEqual(body.origin, { code: ORIGIN, name: 'Banani Road 11' });
    assert.deepStrictEqual(body.destination, {
      code: DESTINATION,
      name: 'Mohakhali Bus Terminal',
    });
    assert.strictEqual(body.trafficProfile, 'RUSH_HOUR');
    assert.strictEqual(body.fare.currency, 'BDT');
    assert.strictEqual(body.fare.pricingCode, env.fare.pricingCode);
    assert.strictEqual(body.fare.pricingVersion, expected.policy.version);

    // The route the fare was calculated over is the route the router returns.
    assert.strictEqual(body.route.distanceMeters, expected.route.distanceMeters);
    assert.strictEqual(body.route.durationSeconds, expected.route.durationSeconds);

    // ...and every money figure matches the documented formula.
    for (const field of MONEY_FIELDS) {
      assert.strictEqual(body.fare[field], expected[field], `fare.${field}`);
    }
    assert.strictEqual(body.fare.minimumFareApplied, expected.minimumFareApplied);
  });

  it('returns exactly the documented fields', async () => {
    const body = await quoteOk(request());

    assert.deepStrictEqual(Object.keys(body).sort(), QUOTE_KEYS);
    assert.deepStrictEqual(Object.keys(body.fare).sort(), [
      'baseFare',
      'currency',
      'distanceFare',
      'fareRoundingAdjustment',
      'finalFare',
      'minimumFareApplied',
      'preTrafficSubtotal',
      'pricingCode',
      'pricingVersion',
      'timeFare',
      'trafficAdjustment',
      'trafficMultiplier',
      'unroundedFare',
    ]);

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'fareWeight',
      'perKilometerRate',
      'perMinuteRate',
      'routeSnapshot',
      'fareBreakdown',
      'graphNodeId',
      'graphEdgeId',
      'pool',
      'discount',
      'surge',
      'payment',
      'wallet',
      'rideRequest',
    ]) {
      assert.ok(!serialized.includes(forbidden), `the response must not contain ${forbidden}`);
    }
  });

  it('returns money as exact decimal strings, with the charge a whole number', async () => {
    const body = await quoteOk(request());
    const fare = body.fare;

    // The components are amounts at the policy's scale, so they keep their
    // decimals -- the snap applies to the fare and to nothing underneath it.
    for (const field of COMPONENT_FIELDS) {
      assert.strictEqual(typeof fare[field], 'string', `${field} must be a string`);
      assert.match(fare[field], /^-?\d+\.\d{2}$/, `${field} must be a two-decimal amount`);
    }

    // The money that changes hands is a whole number of taka.
    assert.strictEqual(typeof fare.finalFare, 'string');
    assert.match(fare.finalFare, /^\d+$/, 'the charged fare must be a whole number');

    // A client can check the arithmetic from the response alone.
    const base = new Prisma.Decimal(fare.baseFare);
    const distance = new Prisma.Decimal(fare.distanceFare);
    const time = new Prisma.Decimal(fare.timeFare);
    const subtotal = new Prisma.Decimal(fare.preTrafficSubtotal);
    const adjustment = new Prisma.Decimal(fare.trafficAdjustment);
    const unrounded = new Prisma.Decimal(fare.unroundedFare);
    const rounding = new Prisma.Decimal(fare.fareRoundingAdjustment);
    const final = new Prisma.Decimal(fare.finalFare);

    assert.ok(subtotal.equals(base.plus(distance).plus(time)), 'the components must add up');
    assert.ok(unrounded.equals(subtotal.plus(adjustment)), 'the pre-rounding total must be subtotal + adjustment');
    assert.ok(final.equals(unrounded.plus(rounding)), 'the charge must be the rounding applied to it');
    assert.ok(final.div(10).isInteger(), 'the charge must be a whole number of 10 taka');
    assert.ok(rounding.abs().times(2).lte(10), 'rounding never moves a fare more than half a unit');
  });

  it('formats kilometres to the metre and minutes to the second', async () => {
    const body = await quoteOk(request());
    const expected = await expectedFare(request());

    assert.strictEqual(body.route.distanceKilometers, '2.214');
    assert.strictEqual(body.route.durationMinutes, expected.durationMinutes);
  });

  it('is deterministic: the same request prices the same journey identically', async () => {
    const first = await quoteOk(request());
    const second = await quoteOk(request());

    assert.notStrictEqual(first.quoteId, second.quoteId);
    assert.deepStrictEqual(first.fare, second.fare);
    assert.deepStrictEqual(first.route, second.route);
    assert.deepStrictEqual(first.origin, second.origin);
  });

  it('includes the base fare exactly once', async () => {
    const body = await quoteOk(request());
    const fare = body.fare;

    assert.strictEqual(fare.baseFare, '40.00');
    assert.ok(
      new Prisma.Decimal(fare.preTrafficSubtotal)
        .minus(fare.distanceFare)
        .minus(fare.timeFare)
        .equals(fare.baseFare),
      'the subtotal minus the usage charges has to be the base fare, once',
    );
  });

  it('uses the routed duration for the time fare', async () => {
    const rush = await quoteOk(request({ departureAt: RUSH_HOUR_DEPARTURE }));
    const normal = await quoteOk(request({ departureAt: NORMAL_DEPARTURE }));

    // Same journey, same distance, different duration: only the time fare and the
    // traffic multiplier may differ.
    assert.strictEqual(rush.route.distanceMeters, normal.route.distanceMeters);
    assert.strictEqual(rush.fare.distanceFare, normal.fare.distanceFare);
    assert.ok(rush.route.durationSeconds > normal.route.durationSeconds);
    assert.ok(
      new Prisma.Decimal(rush.fare.timeFare).greaterThan(normal.fare.timeFare),
      'a slower journey has to cost more time fare',
    );
  });

  it('applies the normal multiplier outside the peak, and the rush-hour one inside it', async () => {
    const rush = await quoteOk(request({ departureAt: RUSH_HOUR_DEPARTURE }));
    const normal = await quoteOk(request({ departureAt: NORMAL_DEPARTURE }));

    assert.strictEqual(rush.trafficProfile, 'RUSH_HOUR');
    assert.strictEqual(normal.trafficProfile, 'NORMAL');
    assert.strictEqual(rush.fare.trafficMultiplier, '1.10');
    assert.strictEqual(normal.fare.trafficMultiplier, '1.00');

    // The off-peak multiplier is 1.00, so there is no traffic adjustment at all:
    // the peak surcharge is the only traffic adjustment in the formula.
    assert.strictEqual(normal.fare.trafficAdjustment, '0.00');
    assert.strictEqual(normal.fare.unroundedFare, normal.fare.preTrafficSubtotal);
    assert.notStrictEqual(rush.fare.trafficAdjustment, '0.00');
    assert.ok(new Prisma.Decimal(rush.fare.finalFare).greaterThan(normal.fare.finalFare));
  });

  it('applies the multiplier exactly once', async () => {
    const body = await quoteOk(request({ departureAt: RUSH_HOUR_DEPARTURE }));
    const fare = body.fare;

    const subtotal = new Prisma.Decimal(fare.preTrafficSubtotal);
    const multiplier = new Prisma.Decimal(fare.trafficMultiplier);
    const adjustment = new Prisma.Decimal(fare.trafficAdjustment);

    assert.ok(adjustment.equals(subtotal.times(multiplier.minus(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)));
    assert.ok(new Prisma.Decimal(fare.unroundedFare).equals(subtotal.plus(adjustment)));
    // A second application would be subtotal × 1.10 × 1.10.
    assert.notStrictEqual(
      fare.finalFare,
      subtotal.times(multiplier).times(multiplier).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2),
    );
  });

  it('enforces the minimum fare on a short journey', async () => {
    const body = await quoteOk(
      request({
        originServicePointCode: SHORT_ORIGIN,
        destinationServicePointCode: SHORT_DESTINATION,
        departureAt: RUSH_HOUR_DEPARTURE,
      }),
    );
    const expected = await expectedFare({
      originServicePointCode: SHORT_ORIGIN,
      destinationServicePointCode: SHORT_DESTINATION,
      departureAt: RUSH_HOUR_DEPARTURE,
    });

    assert.ok(
      new Prisma.Decimal(body.fare.preTrafficSubtotal).lessThan(expected.minimumFare),
      'the calculated fare has to be under the floor for this to be a minimum-fare case',
    );
    assert.strictEqual(body.fare.minimumFareApplied, true);
    assert.strictEqual(body.fare.unroundedFare, expected.minimumFare);
    assert.strictEqual(body.fare.finalFare, expected.finalFare);
    assert.strictEqual(body.fare.finalFare, '80');

    // The floor is a floor, not a substitution: the components are still recorded.
    assert.strictEqual(body.fare.baseFare, '40.00');
    assert.notStrictEqual(body.fare.distanceFare, '0.00');
  });

  it('says the minimum was not applied when it was not', async () => {
    const body = await quoteOk(request());
    const fare = body.fare;

    assert.strictEqual(fare.minimumFareApplied, false);
    assert.ok(
      new Prisma.Decimal(fare.finalFare).greaterThan('80.00'),
      'this journey is above the floor',
    );
    assert.ok(
      new Prisma.Decimal(fare.unroundedFare).equals(
        new Prisma.Decimal(fare.preTrafficSubtotal).plus(fare.trafficAdjustment),
      ),
      'without a floor, the protected fare is simply the adjusted subtotal',
    );
  });
});

describe('edge fare weight', () => {
  it('multiplies the distance fare of the edge it belongs to', async () => {
    const before = await quoteOk(request());
    assert.strictEqual(before.fare.distanceFare, '59.78', 'the seeded weight is 1.5');

    const seeded = await pool.routingEdge.findUnique({
      where: { code: WEIGHTED_EDGE },
      select: { fareWeight: true },
    });
    assert.strictEqual(seeded.fareWeight.toString(), '1.5');

    await pool.query(`UPDATE routing_edges SET fare_weight = 3.000 WHERE code = $1`, [WEIGHTED_EDGE]);
    try {
      const doubled = await quoteOk(request());
      const expected = await expectedFare(request());

      assert.strictEqual(doubled.fare.distanceFare, '119.56', 'doubling the weight doubles the charge');
      assert.strictEqual(
        doubled.fare.distanceFare,
        new Prisma.Decimal(before.fare.distanceFare).times(2).toFixed(2),
      );
      assert.strictEqual(doubled.fare.distanceFare, expected.distanceFare);

      // The time fare is untouched: the weight is a distance charge only.
      assert.strictEqual(doubled.fare.timeFare, before.fare.timeFare);
      assert.strictEqual(doubled.route.distanceMeters, before.route.distanceMeters);
    } finally {
      await pool.query(`UPDATE routing_edges SET fare_weight = $2 WHERE code = $1`, [
        WEIGHTED_EDGE,
        seeded.fareWeight.toString(),
      ]);
    }
  });

  it('does not change which route is selected', async () => {
    const before = await quoteOk(request());
    const beforeEdges = (await storedQuote(before.quoteId)).routeSnapshot.edges.map((edge) => edge.edgeCode);

    await pool.query(`UPDATE routing_edges SET fare_weight = 999.000 WHERE code = $1`, [WEIGHTED_EDGE]);
    try {
      const after = await quoteOk(request());
      const afterSnapshot = (await storedQuote(after.quoteId)).routeSnapshot.edges;

      assert.deepStrictEqual(
        afterSnapshot.map((edge) => edge.edgeCode),
        beforeEdges,
        'fare weight must not influence the path the router chose',
      );
      assert.strictEqual(after.route.distanceMeters, before.route.distanceMeters);
      assert.strictEqual(after.route.durationSeconds, before.route.durationSeconds);
      assert.ok(
        new Prisma.Decimal(after.fare.finalFare).greaterThan(before.fare.finalFare),
        'it does make that path more expensive',
      );
    } finally {
      await pool.query(`UPDATE routing_edges SET fare_weight = 1.500 WHERE code = $1`, [WEIGHTED_EDGE]);
    }
  });
});

describe('the stored quote', () => {
  it('references the exact policy version it was calculated with', async () => {
    const body = await quoteOk(request());
    const stored = await storedQuote(body.quoteId);

    const policy = await pool.farePolicy.findFirst({
      where: { code: env.fare.pricingCode, version: body.fare.pricingVersion },
    });

    assert.strictEqual(stored.farePolicyId, policy.id);
    assert.strictEqual(stored.pricingCode, policy.code);
    assert.strictEqual(stored.pricingVersion, policy.version);
    assert.strictEqual(stored.currency, 'BDT');
    assert.strictEqual(stored.finalFare.toFixed(0), body.fare.finalFare);
    assert.strictEqual(stored.fareRoundingUnit.toFixed(0), '10');
    assert.strictEqual(
      stored.fareRoundingAdjustment.toFixed(2),
      body.fare.fareRoundingAdjustment,
    );
  });

  it('stores an auditable snapshot of the edges that were priced', async () => {
    const body = await quoteOk(request());
    const stored = await storedQuote(body.quoteId);

    assert.strictEqual(stored.routeSnapshot.origin.code, ORIGIN);
    assert.strictEqual(stored.routeSnapshot.destination.code, DESTINATION);
    assert.strictEqual(stored.routeSnapshot.trafficProfile, 'RUSH_HOUR');
    assert.strictEqual(stored.routeSnapshot.geometry.type, 'LineString');
    assert.ok(stored.routeSnapshot.geometry.coordinates.length >= 2);

    const edges = stored.routeSnapshot.edges;
    assert.ok(edges.length >= 1);
    assert.deepStrictEqual(
      edges.map((edge) => edge.sequence),
      edges.map((_edge, index) => index + 1),
      'the snapshot must be in path order',
    );

    const graphWeights = await pool.routingEdge.findMany({
      where: { code: { in: edges.map((edge) => edge.edgeCode) } },
      select: { code: true, distanceMeters: true, fareWeight: true },
    });
    const graphByCode = new Map(graphWeights.map((edge) => [edge.code, edge]));

    let chargeSum = new Prisma.Decimal(0);
    for (const edge of edges) {
      const fromGraph = graphByCode.get(edge.edgeCode);
      assert.ok(fromGraph, `edge ${edge.edgeCode} must exist in the graph`);
      assert.ok(['FORWARD', 'BACKWARD'].includes(edge.direction));
      assert.strictEqual(edge.distanceMeters, Math.round(Number(fromGraph.distanceMeters)));
      assert.ok(new Prisma.Decimal(edge.fareWeight).equals(fromGraph.fareWeight));
      assert.ok(Number.isInteger(edge.durationSeconds) && edge.durationSeconds > 0);
      chargeSum = chargeSum.plus(edge.distanceCharge);
    }

    // The snapshot explains the distance fare on its own: its per-edge charges
    // are exactly what the quote charged.
    assert.ok(chargeSum.equals(stored.distanceFare), 'the snapshot charges must add up');
    assert.strictEqual(stored.routeSnapshot.distanceFare, stored.distanceFare.toFixed(2));
  });

  it('stores the whole breakdown, so it can be reproduced later', async () => {
    const body = await quoteOk(request());
    const stored = await storedQuote(body.quoteId);
    const breakdown = stored.fareBreakdown;

    assert.strictEqual(breakdown.currency, 'BDT');
    assert.strictEqual(breakdown.pricingVersion, body.fare.pricingVersion);
    assert.deepStrictEqual(breakdown.rounding, { scale: 2, mode: 'HALF_UP', unit: '10' });
    for (const field of MONEY_FIELDS) {
      assert.strictEqual(breakdown.components[field], body.fare[field], `components.${field}`);
    }
    // The rates are stored too, so the quote does not need the policy row to be
    // explained -- which matters once the policy is superseded.
    assert.strictEqual(breakdown.rates.perKilometerRate, '18.0000');
    assert.strictEqual(breakdown.rates.perMinuteRate, '2.0000');
    assert.strictEqual(breakdown.rates.appliedTrafficMultiplier, '1.10');
    assert.strictEqual(breakdown.quantities.distanceMeters, body.route.distanceMeters);
  });

  it('cannot be modified afterwards', async () => {
    const body = await quoteOk(request());

    await withRollback(async (tx) => {
      const err = await expectPgError(
        tx,
        () => tx.fareQuote.update({ where: { id: body.quoteId }, data: { finalFare: '1.00' } }),
        '23514',
      );
      assert.match(err.message, /immutable/);
    });
  });

  it('is not reachable through any service operation that could change it', () => {
    const mutating = Object.keys(fareService).filter((name) =>
      /update|delete|remove|set|patch|modify/i.test(name),
    );

    assert.deepStrictEqual(mutating, [], 'a quote is written once and read afterwards');
  });
});

describe('expiry', () => {
  it('is created plus the policy TTL, and expiry never deletes the quote', async () => {
    const policy = await pool.farePolicy.findFirst({ where: { code: env.fare.pricingCode } });

    // TTL is operational metadata, so shortening it is allowed even though the
    // policy has been quoted. One second makes the deadline reachable in a test.
    await pool.farePolicy.update({ where: { id: policy.id }, data: { quoteTtlSeconds: 1 } });
    try {
      const before = await pool.fareQuote.count();
      const body = await quoteOk(request());
      const stored = await storedQuote(body.quoteId);

      assert.strictEqual(stored.expiresAt.getTime() - stored.createdAt.getTime(), 1000);
      assert.strictEqual(stored.expiresAt.toISOString(), body.expiresAt);
      assert.strictEqual(isQuoteExpired(stored, stored.createdAt), false);

      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const after = await storedQuote(body.quoteId);
      assert.ok(after, 'an expired quote must still be stored');
      assert.strictEqual(isQuoteExpired(after), true);
      assert.strictEqual(await pool.fareQuote.count(), before + 1, 'expiry must not prune anything');
    } finally {
      await pool.farePolicy.update({
        where: { id: policy.id },
        data: { quoteTtlSeconds: policy.quoteTtlSeconds },
      });
    }
  });
});

describe('a client cannot influence the price', () => {
  it('rejects a body that supplies distance, duration, fare or policy fields', async () => {
    for (const injected of [
      { distanceMeters: 1 },
      { durationSeconds: 1 },
      { finalFare: '0.00' },
      { distanceFare: '0.00' },
      { pricingVersion: 2 },
      { pricingCode: 'free-rides' },
      { fareWeight: 0 },
      { trafficMultiplier: '0.00' },
      { trafficProfile: 'NORMAL' },
      { currency: 'USD' },
      { minimumFareApplied: true },
    ]) {
      const response = await quote(request(injected));
      assert.strictEqual(response.status, 400, JSON.stringify(response.body));
      assert.match(response.body.error.message, /Unsupported body field/);
    }
  });

  it('prices the same journey identically whether or not a client tries', async () => {
    const clean = await quoteOk(request());
    const rejected = await quote(request({ distanceMeters: 1, finalFare: '0.00' }));

    assert.strictEqual(rejected.status, 400);

    const second = await quoteOk(request());
    assert.deepStrictEqual(second.fare, clean.fare);
    assert.deepStrictEqual(second.route, clean.route);
  });

  it('ignores a client-supplied departure it cannot parse rather than defaulting', async () => {
    const response = await quote(request({ departureAt: 'yesterday' }));

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /departureAt/);
  });
});

describe('fare quote errors', () => {
  const expectError = async (body, status, pattern) => {
    const response = await quote(body);
    assert.strictEqual(response.status, status, JSON.stringify(response.body));
    assert.match(response.body.error.message, pattern);

    const serialized = JSON.stringify(response.body);
    for (const forbidden of ['SELECT', 'fare_policies', 'pgr_dijkstra', 'perKilometerRate', 'at ', 'Error:']) {
      assert.ok(!serialized.includes(forbidden), `a client must not see "${forbidden}"`);
    }
    return response;
  };

  it('rejects a missing origin or destination with 400', async () => {
    await expectError({ destinationServicePointCode: DESTINATION }, 400, /originServicePointCode is required/);
    await expectError({ originServicePointCode: ORIGIN }, 400, /destinationServicePointCode is required/);
  });

  it('rejects a malformed code or timestamp with 400', async () => {
    await expectError(request({ originServicePointCode: 'not a code!' }), 400, /must be a code/);
    for (const departureAt of ['2026-09-24T08:41', '2026-09-24', '2026-02-30T00:00:00Z', '']) {
      await expectError(request({ departureAt }), 400, /departureAt/);
    }
  });

  it('rejects identical endpoints with 400', async () => {
    await expectError(
      request({ destinationServicePointCode: ORIGIN }),
      400,
      /must differ/,
    );
  });

  it('rejects an unknown service point with 404', async () => {
    await expectError(request({ originServicePointCode: 'no-such-point' }), 404, /was not found/);
    await expectError(request({ destinationServicePointCode: 'no-such-point' }), 404, /was not found/);
  });

  it('rejects an inactive service point with 409', async () => {
    await pool.query(`UPDATE service_points SET active = false WHERE code = $1`, [SHORT_DESTINATION]);
    try {
      await expectError(
        request({ destinationServicePointCode: SHORT_DESTINATION }),
        409,
        /is inactive/,
      );
    } finally {
      await pool.query(`UPDATE service_points SET active = true WHERE code = $1`, [SHORT_DESTINATION]);
    }
  });

  it('reports an unreachable destination with 422', async () => {
    await expectError(
      request({ originServicePointCode: 'khamarbari' }),
      422,
      /No route from "khamarbari"/,
    );
  });

  it('reports a missing pricing policy as a controlled server error', async () => {
    const policy = await pool.farePolicy.findFirst({ where: { code: env.fare.pricingCode } });
    await pool.farePolicy.update({ where: { id: policy.id }, data: { active: false } });
    try {
      await expectError(request(), 500, /Fare pricing is not configured/);
    } finally {
      await pool.farePolicy.update({ where: { id: policy.id }, data: { active: true } });
    }
  });

  it('reports an ambiguous pricing configuration as a controlled server error', async () => {
    const policy = await pool.farePolicy.findFirst({ where: { code: env.fare.pricingCode } });

    const overlapping = await pool.farePolicy.create({
      data: {
        code: policy.code,
        version: policy.version + 100,
        name: 'Overlapping test version',
        currency: policy.currency,
        baseFare: policy.baseFare,
        perKilometerRate: policy.perKilometerRate,
        perMinuteRate: policy.perMinuteRate,
        minimumFare: policy.minimumFare,
        normalTrafficMultiplier: policy.normalTrafficMultiplier,
        rushHourMultiplier: policy.rushHourMultiplier,
        quoteTtlSeconds: policy.quoteTtlSeconds,
        roundingScale: policy.roundingScale,
        active: true,
        effectiveFrom: policy.effectiveFrom,
        effectiveTo: null,
      },
    });

    try {
      await expectError(request(), 500, /Fare pricing configuration is ambiguous/);
    } finally {
      // No quote can reference it: the request failed before anything was stored.
      await pool.farePolicy.delete({ where: { id: overlapping.id } });
    }
  });

  it('recovers: the seeded policy still prices a journey afterwards', async () => {
    const body = await quoteOk(request());

    assert.strictEqual(body.fare.pricingVersion, 1);
    assert.strictEqual(body.fare.currency, 'BDT');
  });
});

describe('phase boundary', () => {
  it('exposes no pooling, shared-fare, payment or matching endpoint', async () => {
    for (const path of [
      '/rides',
      '/pools',
      '/pool-members',
      '/matches',
      '/payments',
      '/wallets',
      '/share',
      '/discounts',
      '/fare-quotes/quote-id',
      '/fare-quotes/quote-id/accept',
      '/fare/quotes',
    ]) {
      const { status } = await api.request(path, { headers: { cookie: authCookie } });
      assert.strictEqual(status, 404, `${path} must not exist in this phase`);
    }

    // The ride-request milestone added POST /ride-requests. The collection is
    // still not readable, and `/rides` -- the shared-ride shape -- still does not
    // exist at all.
    const collection = await api.request('/ride-requests', { headers: { cookie: authCookie } });
    assert.strictEqual(collection.status, 404);
  });

  it('introduces no shared or seated table', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ~ '(ride|pool|dispatch|payment|wallet|shared|match|seat|driver_assignment)'
        ORDER BY table_name`,
    );

    // The TeslaPay milestone added the three wallet tables, so the snapshot now
    // carries them. What this phase still refuses is anything *shared* (a seat
    // count, a pooled fare, an assignment): `pool_*` and `payments` are the
    // per-passenger records this milestone's pricing produced, not a shared ride.
    assert.deepStrictEqual(
      rows.map((row) => row.table_name),
      [
        'dispatch_offers',
        'payments',
        'pool_events',
        'pool_fare_calculations',
        'pool_fare_legs',
        'pool_members',
        'pool_stops',
        'ride_events',
        'ride_pools',
        'ride_requests',
        'wallet_accounts',
        'wallet_ledger',
      ],
      'pricing, ride, pool, shared-fare and wallet tables exist; nothing seated does',
    );
  });

  it('owns a quote by exactly one passenger, and by nobody else', async () => {
    // Quotes became passenger-owned in the ride-request milestone: a request
    // accepts one, and ownership is what stops a quote being used by somebody
    // else. The ownership is a single column, and it is the only identity a quote
    // carries -- no driver, no vehicle, no account.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fare_quotes'
          AND column_name ~ '(user|passenger|driver|account|customer|vehicle)'
        ORDER BY column_name`,
    );

    assert.deepStrictEqual(
      rows.map((row) => row.column_name),
      ['passenger_profile_id'],
    );

    // And the column is populated by the endpoint that creates a quote.
    const body = await quoteOk(request());
    const stored = await storedQuote(body.quoteId);
    assert.ok(stored.passengerProfileId, 'a quote must belong to the passenger who asked for it');
  });

  it('returns the quote without saying who owns it', async () => {
    const body = await quoteOk(request());

    // The passenger knows who they are; the response carries no identifier that
    // could name them, or anybody else.
    const serialized = JSON.stringify(body);
    for (const forbidden of ['passengerProfileId', 'passenger_profile_id', 'passengerId', 'userId']) {
      assert.ok(!serialized.includes(forbidden), `the quote must not mention ${forbidden}`);
    }
  });

  it('leaves route estimation working, pricing-free', async () => {
    const { status, body } = await api.request('/routes/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: authCookie },
      body: JSON.stringify({ originServicePointCode: ORIGIN, destinationServicePointCode: DESTINATION }),
    });

    assert.strictEqual(status, 200);
    const serialized = JSON.stringify(body);
    for (const forbidden of ['fare', 'price', 'cost', 'currency', 'BDT']) {
      assert.ok(!serialized.includes(forbidden), `/routes/estimate must not mention ${forbidden}`);
    }
  });
});
