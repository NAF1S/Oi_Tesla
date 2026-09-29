import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import {
  allSeedPoints,
  edgeCode,
  vertexCode,
} from '../../src/db/seeds/location.seed.js';
import { LOCATION_EDGES } from '../../src/db/seeds/location.data.js';
import { assignGraphEdgeIds, assignGraphNodeIds } from '../../src/db/seeds/graph-ids.js';
import { resolveTrafficProfile } from '../../src/utils/time.js';
import { startApiServer } from '../helpers/api-server.js';
import {
  closePool,
  expectPgError,
  pool,
  prepareDatabase,
  runSeed,
  withRollback,
} from '../helpers/db.js';

/**
 * End-to-end tests for POST /api/routes/estimate, driven through the real Express
 * app over HTTP.
 *
 * Traffic profiles are asserted with fixed instants (08:41 and 12:00 in Dhaka),
 * never with the current clock, so the result does not depend on when the suite
 * runs. Asia/Dhaka is UTC+06:00 with no daylight saving: 08:41 local is 02:41Z.
 *
 * These tests also pin the phase boundary: calculating a route is in scope,
 * pricing it is not.
 */

const ORIGIN = 'banani-road-11';
const DESTINATION = 'mohakhali-bus-terminal';
const ORIGIN_VERTEX = vertexCode(ORIGIN);
const DESTINATION_VERTEX = vertexCode(DESTINATION);

/** 08:41 in Dhaka -- inside the 07:30-10:30 morning peak. */
const RUSH_HOUR_DEPARTURE = '2026-09-24T08:41:00+06:00';
/** 12:00 in Dhaka -- between the two peaks. */
const NORMAL_DEPARTURE = '2026-09-24T12:00:00+06:00';

/** The one-way edge used to prove the direction rules. */
const ONE_WAY_EDGE = edgeCode('shapla-chattar', 'sadarghat');

const RESPONSE_KEYS = [
  'departureAt',
  'destination',
  'distanceKilometers',
  'distanceMeters',
  'durationMinutes',
  'durationSeconds',
  'estimatedArrivalAt',
  'geometry',
  'legs',
  'origin',
  'trafficProfile',
];

let api;

/** The cookie /auth/login issued, replayed on every estimate below. */
let authCookie = null;

/** A JSON POST, optionally carrying a session cookie. */
const jsonPost = (body, cookie) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});

/** Signs in and returns the cookie the API issued, ready to replay. */
const login = async (email) => {
  const response = await api.request(
    '/auth/login',
    jsonPost({ email, password: env.demoSeedPassword }, null),
  );
  assert.strictEqual(
    response.status,
    200,
    `the routing suite could not sign in as ${email}: ${JSON.stringify(response.body)}`,
  );
  return response.setCookie.split(';')[0];
};

/** An estimate sent with the given cookie (or none, when it is falsey). */
const estimateAs = (body, cookie) => api.request('/routes/estimate', jsonPost(body, cookie));

/** An estimate sent as the signed-in demo passenger. */
const estimate = (body) => estimateAs(body, authCookie);

const estimateOk = async (body) => {
  const response = await estimate(body);
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  return response.body;
};

/**
 * Runs a query whose only parameter is a PostgreSQL array.
 *
 * The test executor spreads the parameter list it is given, so the array has to
 * be wrapped to arrive as a single value rather than being spread into one
 * parameter per element.
 */
const queryOneArray = (sql, values) => pool.query(sql, [values]);

/** The graph node identifiers of a service point's routing vertex. */
const graphNodeIdOf = async (pointCode) => {
  const { rows } = await pool.query(
    `SELECT v.graph_node_id::int AS graph_node_id
       FROM service_points p
       JOIN routing_vertices v ON v.id = p.routing_vertex_id
      WHERE p.code = $1`,
    [pointCode],
  );
  assert.strictEqual(rows.length, 1, `service point "${pointCode}" must be seeded`);
  return Number(rows[0].graph_node_id);
};

/** Endpoints (graph node ids) of the named edges, keyed by edge code. */
const edgeEndpoints = async (codes) => {
  const { rows } = await queryOneArray(
    `SELECT e.code,
            s.graph_node_id::int AS source,
            t.graph_node_id::int AS target
       FROM routing_edges e
       JOIN routing_vertices s ON s.id = e.source_vertex_id
       JOIN routing_vertices t ON t.id = e.target_vertex_id
      WHERE e.code = ANY($1::text[])`,
    codes,
  );
  return new Map(rows.map((row) => [row.code, { source: Number(row.source), target: Number(row.target) }]));
};

/** The stored columns of the named edges, keyed by edge code. */
const edgeCosts = async (codes) => {
  const { rows } = await queryOneArray(
    `SELECT code, distance_meters,
            normal_duration_seconds, rush_hour_duration_seconds,
            reverse_normal_duration_seconds, reverse_rush_hour_duration_seconds
       FROM routing_edges
      WHERE code = ANY($1::text[])`,
    codes,
  );
  return new Map(rows.map((row) => [row.code, row]));
};

/** Stored coordinates of a service point, as [longitude, latitude]. */
const storedPointPosition = async (code) => {
  const { rows } = await pool.query(
    `SELECT ST_X(location::geometry)::float8 AS longitude,
            ST_Y(location::geometry)::float8 AS latitude
       FROM service_points WHERE code = $1`,
    [code],
  );
  assert.strictEqual(rows.length, 1);
  return [rows[0].longitude, rows[0].latitude];
};

const assertSamePosition = (actual, expected, message) => {
  assert.ok(Array.isArray(actual) && actual.length === 2, `${message}: not a position`);
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-9, `${message}: longitude is ${actual[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) < 1e-9, `${message}: latitude is ${actual[1]}`);
};

/** The node a leg starts from, and the one it arrives at. */
const nodeBefore = (endpoints, leg) =>
  leg.direction === 'FORWARD' ? endpoints.source : endpoints.target;
const nodeAfter = (endpoints, leg) =>
  leg.direction === 'FORWARD' ? endpoints.target : endpoints.source;

/**
 * Applies a temporary change to an edge and returns the function that puts it
 * back.
 *
 * The API reads the graph through its own connection, so a change wrapped in a
 * rolled-back transaction would not be visible to it. A real write plus a
 * guaranteed restore is what the endpoint can actually observe, and the seeder
 * resets these columns on the next run anyway.
 */
const temporarilyChangeEdge = async (code, applySql) => {
  const { rows } = await pool.query(
    `SELECT bidirectional, reverse_normal_duration_seconds, reverse_rush_hour_duration_seconds
       FROM routing_edges WHERE code = $1`,
    [code],
  );
  assert.strictEqual(rows.length, 1, `edge "${code}" must be seeded`);
  const original = rows[0];

  await pool.query(applySql, [code]);

  return async () => {
    await pool.query(
      `UPDATE routing_edges
          SET bidirectional = $2,
              reverse_normal_duration_seconds = $3,
              reverse_rush_hour_duration_seconds = $4
        WHERE code = $1`,
      [
        code,
        original.bidirectional,
        original.reverse_normal_duration_seconds,
        original.reverse_rush_hour_duration_seconds,
      ],
    );
  };
};

const ENABLE_REVERSE_LEG = `UPDATE routing_edges
     SET bidirectional = true,
         reverse_normal_duration_seconds = normal_duration_seconds,
         reverse_rush_hour_duration_seconds = rush_hour_duration_seconds
   WHERE code = $1`;

const SLOW_DOWN_REVERSE_LEG = `UPDATE routing_edges
     SET reverse_normal_duration_seconds = normal_duration_seconds + 120,
         reverse_rush_hour_duration_seconds = rush_hour_duration_seconds + 180
   WHERE code = $1`;

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  // The endpoint is authenticated now, so the suite signs in once as a seeded
  // demo account and replays that cookie. It is only ever read, never changed:
  // the demo cast itself is left alone.
  authCookie = await login('nusrat@example.com');
});

after(async () => {
  await api?.close();
  await closePool();
});

describe('authentication', () => {
  const request = {
    originServicePointCode: ORIGIN,
    destinationServicePointCode: DESTINATION,
    departureAt: NORMAL_DEPARTURE,
  };

  it('rejects an unauthenticated estimate with 401', async () => {
    const response = await estimateAs(request, null);

    assert.strictEqual(response.status, 401);
    assert.match(response.body.error.message, /Authentication required/);
  });

  it('rejects an estimate carrying a malformed, tampered or unrelated cookie', async () => {
    for (const cookie of [
      'teslab_auth=not-a-token',
      `teslab_auth=${'x'.repeat(80)}`,
      // A real token whose signature has been edited.
      `${authCookie.slice(0, -1)}${authCookie.endsWith('a') ? 'b' : 'a'}`,
      'some_other_cookie=1',
    ]) {
      const response = await estimateAs(request, cookie);
      assert.strictEqual(response.status, 401, `expected 401 for cookie "${cookie}"`);
      assert.match(response.body.error.message, /Authentication required/);
    }
  });

  it('answers an authenticated passenger', async () => {
    const response = await estimateAs(request, authCookie);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(Object.keys(response.body).sort(), RESPONSE_KEYS);
  });

  it('answers an authenticated driver too, because no role is required', async () => {
    const driverCookie = await login('jashim@example.com');
    const response = await estimateAs(request, driverCookie);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.origin.code, ORIGIN);
  });

  it('rejects an account deactivated after the token was issued', async () => {
    // The token is still valid, so a 401 here proves the guard re-reads the user
    // from the database rather than trusting the token.
    const email = 'nusrat@example.com';
    await pool.query(`UPDATE users SET active = false WHERE email = $1`, [email]);

    try {
      const response = await estimateAs(request, authCookie);

      assert.strictEqual(response.status, 401);
      assert.match(response.body.error.message, /Authentication required/);
    } finally {
      // The seeder restores this too (it upserts the demo cast as active), but
      // the session has to be usable again for the rest of the suite.
      await pool.query(`UPDATE users SET active = true WHERE email = $1`, [email]);
    }
  });

  it('authenticates before it looks at the request, so a bad body is not a 400 for a stranger', async () => {
    const response = await estimateAs({}, null);

    assert.strictEqual(response.status, 401);
  });

  it('does not reveal whether a hidden path exists to an unauthenticated caller', async () => {
    const response = await api.request('/routes/quote', jsonPost({}, null));

    assert.strictEqual(response.status, 404);
  });
});

describe('pgRouting installation', () => {
  it('has both postgis and pgrouting enabled', async () => {
    const { rows } = await pool.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pgrouting') ORDER BY extname`,
    );

    assert.deepStrictEqual(
      rows.map((row) => row.extname),
      ['pgrouting', 'postgis'],
    );
  });

  it('can call pgr_version, so the extension is usable and not just registered', async () => {
    const { rows } = await pool.query(`SELECT pgr_version() AS version`);
    assert.match(String(rows[0].version), /^3\./);
  });
});

describe('graph identifiers', () => {
  it('keeps the UUID domain keys and adds positive integer graph identifiers', async () => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM routing_vertices) AS vertices,
              (SELECT count(*)::int FROM routing_vertices WHERE graph_node_id IS NULL) AS null_nodes,
              (SELECT count(DISTINCT graph_node_id)::int FROM routing_vertices) AS distinct_nodes,
              (SELECT min(graph_node_id) FROM routing_vertices) AS min_node,
              (SELECT count(*)::int FROM routing_edges) AS edges,
              (SELECT count(*)::int FROM routing_edges WHERE graph_edge_id IS NULL) AS null_edges,
              (SELECT count(DISTINCT graph_edge_id)::int FROM routing_edges) AS distinct_edges,
              (SELECT min(graph_edge_id) FROM routing_edges) AS min_edge,
              (SELECT pg_typeof(id)::text FROM routing_vertices LIMIT 1) AS vertex_id_type,
              (SELECT pg_typeof(graph_node_id)::text FROM routing_vertices LIMIT 1) AS node_id_type,
              (SELECT pg_typeof(graph_edge_id)::text FROM routing_edges LIMIT 1) AS edge_id_type`,
    );
    const row = rows[0];

    assert.ok(row.vertices >= 45);
    assert.ok(row.edges >= 45);
    assert.strictEqual(row.null_nodes, 0, 'every vertex needs a graph node id');
    assert.strictEqual(row.null_edges, 0, 'every edge needs a graph edge id');
    assert.strictEqual(row.distinct_nodes, row.vertices);
    assert.strictEqual(row.distinct_edges, row.edges);
    assert.ok(Number(row.min_node) > 0 && Number(row.min_edge) > 0, 'pgRouting needs ids above zero');

    // The public identifiers were not replaced: the foreign keys still point at them.
    assert.strictEqual(row.vertex_id_type, 'uuid');
    assert.strictEqual(row.node_id_type, 'bigint');
    assert.strictEqual(row.edge_id_type, 'bigint');
  });

  it('agrees exactly with the seeder\'s deterministic assignment', async () => {
    const expectedNodes = assignGraphNodeIds(allSeedPoints().map((point) => vertexCode(point.code)));
    const expectedEdges = assignGraphEdgeIds(LOCATION_EDGES.map((edge) => edgeCode(edge.from, edge.to)));

    const { rows: vertexRows } = await pool.query(`SELECT code, graph_node_id FROM routing_vertices`);
    const { rows: edgeRows } = await pool.query(`SELECT code, graph_edge_id FROM routing_edges`);

    // A fixture-triggered row (a user-created vertex, say) is not part of the
    // seeded graph and is not expected to follow the ranking rule; only the
    // seeded codes are compared.
    const seededVertices = vertexRows.filter((row) => expectedNodes.has(row.code));
    const seededEdges = edgeRows.filter((row) => expectedEdges.has(row.code));

    assert.strictEqual(seededVertices.length, expectedNodes.size, 'every seeded vertex must exist');
    assert.strictEqual(seededEdges.length, expectedEdges.size, 'every seeded edge must exist');

    for (const row of seededVertices) {
      assert.strictEqual(
        Number(row.graph_node_id),
        expectedNodes.get(row.code),
        `graph node id for ${row.code}`,
      );
    }

    for (const row of seededEdges) {
      assert.strictEqual(
        Number(row.graph_edge_id),
        expectedEdges.get(row.code),
        `graph edge id for ${row.code}`,
      );
    }
  });

  it('refuses to reassign a graph identifier, so routes cannot be repointed', async () => {
    await withRollback(async (tx) => {
      const err = await expectPgError(
        tx,
        () => tx.query(`UPDATE routing_vertices SET graph_node_id = graph_node_id + 1000`),
        '23514',
      );

      assert.match(err.message, /immutable/);
    });
  });
});

describe('POST /api/routes/estimate', () => {
  it('routes Banani Road 11 to Mohakhali Bus Terminal', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: RUSH_HOUR_DEPARTURE,
    });

    assert.deepStrictEqual(body.origin, { code: ORIGIN, name: 'Banani Road 11' });
    assert.deepStrictEqual(body.destination, {
      code: DESTINATION,
      name: 'Mohakhali Bus Terminal',
    });
    assert.strictEqual(body.trafficProfile, 'RUSH_HOUR');
    assert.ok(body.distanceMeters > 0);
    assert.ok(body.durationSeconds > 0);
    assert.ok(body.legs.length >= 1);
  });

  it('returns exactly the documented fields, and nothing internal', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: NORMAL_DEPARTURE,
    });

    assert.deepStrictEqual(Object.keys(body).sort(), RESPONSE_KEYS);

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'graph_node_id',
      'graph_edge_id',
      'graphNodeId',
      'graphEdgeId',
      'source_vertex',
      'fare',
      'fareWeight',
      'created_at',
      'updated_at',
      'reverse_cost',
      '"active"',
    ]) {
      assert.ok(!serialized.includes(forbidden), `the response must not expose ${forbidden}`);
    }
  });

  it('returns legs in path order, with contiguous sequence numbers', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: NORMAL_DEPARTURE,
    });

    assert.deepStrictEqual(
      body.legs.map((leg) => leg.sequence),
      body.legs.map((_leg, index) => index + 1),
    );

    for (const leg of body.legs) {
      assert.ok(['FORWARD', 'BACKWARD'].includes(leg.direction));
      assert.ok(leg.edgeCode.startsWith('edge-'));
      assert.ok(Number.isInteger(leg.distanceMeters) && leg.distanceMeters > 0);
      assert.ok(Number.isInteger(leg.durationSeconds) && leg.durationSeconds > 0);
    }
  });

  it('joins consecutive legs at the node they share', async () => {
    const body = await estimateOk({
      originServicePointCode: 'gulshan-1-circle',
      destinationServicePointCode: 'bashundhara-gate',
      departureAt: NORMAL_DEPARTURE,
    });

    assert.ok(body.legs.length > 1, 'this pair needs more than one edge');

    const endpoints = await edgeEndpoints(body.legs.map((leg) => leg.edgeCode));
    const originNode = await graphNodeIdOf('gulshan-1-circle');
    const destinationNode = await graphNodeIdOf('bashundhara-gate');

    // The first leg leaves the origin's vertex...
    assert.strictEqual(nodeBefore(endpoints.get(body.legs[0].edgeCode), body.legs[0]), originNode);

    // ...every leg arrives where the next one departs...
    for (let index = 0; index < body.legs.length - 1; index += 1) {
      const arrives = nodeAfter(
        endpoints.get(body.legs[index].edgeCode),
        body.legs[index],
      );
      const departs = nodeBefore(
        endpoints.get(body.legs[index + 1].edgeCode),
        body.legs[index + 1],
      );
      assert.strictEqual(arrives, departs, `legs ${index + 1} and ${index + 2} are not connected`);
    }

    // ...and the last one arrives at the destination's vertex.
    assert.strictEqual(
      nodeAfter(endpoints.get(body.legs.at(-1).edgeCode), body.legs.at(-1)),
      destinationNode,
    );
  });

  it('sums distance and duration from the traversed edges only', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: NORMAL_DEPARTURE,
    });

    const stored = await edgeCosts(body.legs.map((leg) => leg.edgeCode));

    let expectedDistance = 0;
    let expectedDuration = 0;

    for (const leg of body.legs) {
      const edge = stored.get(leg.edgeCode);
      assert.ok(edge, `leg ${leg.sequence} references a stored edge`);

      expectedDistance += Math.round(Number(edge.distance_meters));
      expectedDuration +=
        leg.direction === 'FORWARD'
          ? edge.normal_duration_seconds
          : edge.reverse_normal_duration_seconds;

      assert.strictEqual(leg.distanceMeters, Math.round(Number(edge.distance_meters)));
      assert.strictEqual(
        leg.durationSeconds,
        leg.direction === 'FORWARD'
          ? edge.normal_duration_seconds
          : edge.reverse_normal_duration_seconds,
      );
    }

    assert.strictEqual(body.distanceMeters, expectedDistance);
    assert.strictEqual(body.durationSeconds, expectedDuration);
    assert.strictEqual(
      body.durationSeconds,
      body.legs.reduce((total, leg) => total + leg.durationSeconds, 0),
    );
  });

  it('calculates the arrival time from the departure time and the duration', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: RUSH_HOUR_DEPARTURE,
    });

    assert.strictEqual(body.departureAt, '2026-09-24T02:41:00.000Z');
    assert.strictEqual(
      new Date(body.estimatedArrivalAt).getTime() - new Date(body.departureAt).getTime(),
      body.durationSeconds * 1000,
    );
  });

  it('returns a LineString that starts at the origin and ends at the destination', async () => {
    const body = await estimateOk({
      originServicePointCode: 'gulshan-1-circle',
      destinationServicePointCode: 'bashundhara-gate',
      departureAt: NORMAL_DEPARTURE,
    });

    assert.strictEqual(body.geometry.type, 'LineString');
    assert.ok(body.geometry.coordinates.length >= body.legs.length + 1);

    for (const position of body.geometry.coordinates) {
      assert.strictEqual(position.length, 2);
      assert.ok(Number.isFinite(position[0]) && Math.abs(position[0]) <= 180);
      assert.ok(Number.isFinite(position[1]) && Math.abs(position[1]) <= 90);
    }

    assertSamePosition(
      body.geometry.coordinates[0],
      await storedPointPosition('gulshan-1-circle'),
      'the route must start at the origin',
    );
    assertSamePosition(
      body.geometry.coordinates.at(-1),
      await storedPointPosition('bashundhara-gate'),
      'the route must end at the destination',
    );
  });

  it('follows path order rather than edge row order', async () => {
    const body = await estimateOk({
      originServicePointCode: 'gulshan-1-circle',
      destinationServicePointCode: 'bashundhara-gate',
      departureAt: NORMAL_DEPARTURE,
    });

    assert.ok(body.legs.length > 1, 'this pair needs more than one edge');

    // Every position in this seed is a routing vertex (each edge is a straight
    // two-point line between two of them), so the merged geometry can be read
    // back as the node sequence it visited. That is the whole point of ordering
    // the legs by the pgRouting sequence instead of by edge id.
    const { rows } = await pool.query(
      `SELECT graph_node_id::int AS graph_node_id,
              ST_X(location)::float8 AS longitude,
              ST_Y(location)::float8 AS latitude
         FROM routing_vertices`,
    );
    const nodeByPosition = new Map(
      rows.map((row) => [`${row.longitude},${row.latitude}`, Number(row.graph_node_id)]),
    );

    const visited = body.geometry.coordinates.map(([longitude, latitude]) =>
      nodeByPosition.get(`${longitude},${latitude}`),
    );
    assert.ok(
      visited.every((node) => typeof node === 'number'),
      'every position on the route must be a seeded vertex',
    );

    const endpoints = await edgeEndpoints(body.legs.map((leg) => leg.edgeCode));
    const expected = [];
    for (const leg of body.legs) {
      expected.push(nodeBefore(endpoints.get(leg.edgeCode), leg));
    }
    expected.push(nodeAfter(endpoints.get(body.legs.at(-1).edgeCode), body.legs.at(-1)));

    assert.deepStrictEqual(
      visited,
      expected,
      'the geometry must visit the legs\' nodes in the order they were travelled',
    );

    assertSamePosition(
      body.geometry.coordinates[0],
      await storedPointPosition('gulshan-1-circle'),
      'the route must start at the origin',
    );
    assertSamePosition(
      body.geometry.coordinates.at(-1),
      await storedPointPosition('bashundhara-gate'),
      'the route must end at the destination',
    );
  });

  it('uses pgRouting, with the profile duration as the edge cost', async () => {
    // An independent oracle: the same graph walked by pgr_dijkstra directly, with
    // the rush-hour columns as cost. If the service's duration disagrees with the
    // path cost, the endpoint is not routing on duration.
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: RUSH_HOUR_DEPARTURE,
    });

    const { rows } = await pool.query(
      `WITH path AS (
         SELECT * FROM pgr_dijkstra($1::text, $2::bigint, $3::bigint, directed := true)
       )
       SELECT count(*) FILTER (WHERE edge <> -1)::int AS traversed,
              coalesce(sum(cost) FILTER (WHERE edge <> -1), 0)::float8 AS total_cost
         FROM path`,
      [
        `SELECT e.graph_edge_id AS id,
                s.graph_node_id AS source,
                t.graph_node_id AS target,
                e.rush_hour_duration_seconds::float8 AS cost,
                CASE WHEN e.bidirectional THEN e.reverse_rush_hour_duration_seconds::float8 ELSE -1 END AS reverse_cost
           FROM routing_edges e
           JOIN routing_vertices s ON s.id = e.source_vertex_id
           JOIN routing_vertices t ON t.id = e.target_vertex_id
          WHERE e.active AND s.active AND t.active`,
        await graphNodeIdOf(ORIGIN),
        await graphNodeIdOf(DESTINATION),
      ],
    );

    assert.strictEqual(rows[0].traversed, body.legs.length);
    assert.strictEqual(Math.round(rows[0].total_cost), body.durationSeconds);
  });
});

describe('traffic profiles', () => {
  it('estimates a rush-hour departure with rush-hour costs', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: RUSH_HOUR_DEPARTURE,
    });

    assert.strictEqual(body.trafficProfile, 'RUSH_HOUR');

    const stored = await edgeCosts(body.legs.map((leg) => leg.edgeCode));
    for (const leg of body.legs) {
      const edge = stored.get(leg.edgeCode);
      assert.strictEqual(
        leg.durationSeconds,
        leg.direction === 'FORWARD'
          ? edge.rush_hour_duration_seconds
          : edge.reverse_rush_hour_duration_seconds,
      );
    }
  });

  it('estimates an off-peak departure with normal costs, and takes less time', async () => {
    const request = {
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
    };

    const rush = await estimateOk({ ...request, departureAt: RUSH_HOUR_DEPARTURE });
    const normal = await estimateOk({ ...request, departureAt: NORMAL_DEPARTURE });

    assert.strictEqual(normal.trafficProfile, 'NORMAL');
    assert.deepStrictEqual(
      normal.legs.map((leg) => leg.edgeCode),
      rush.legs.map((leg) => leg.edgeCode),
      'the same path is expected in and out of the peak',
    );
    assert.ok(
      rush.durationSeconds > normal.durationSeconds,
      `rush hour must be slower: ${rush.durationSeconds}s vs ${normal.durationSeconds}s`,
    );
    assert.strictEqual(normal.distanceMeters, rush.distanceMeters, 'the path length does not change');

    const stored = await edgeCosts(normal.legs.map((leg) => leg.edgeCode));
    for (const leg of normal.legs) {
      const edge = stored.get(leg.edgeCode);
      assert.strictEqual(
        leg.durationSeconds,
        leg.direction === 'FORWARD'
          ? edge.normal_duration_seconds
          : edge.reverse_normal_duration_seconds,
      );
    }
  });

  it('decides the profile from the Dhaka clock, not from the notation used', async () => {
    const withOffset = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: '2026-09-24T08:41:00+06:00',
    });
    const withZulu = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: '2026-09-24T02:41:00Z',
    });

    assert.strictEqual(withOffset.trafficProfile, 'RUSH_HOUR');
    assert.deepStrictEqual(withOffset, withZulu);
  });

  it('uses the current time when no departure is given', async () => {
    const before = Date.now();
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
    });
    const after = Date.now();

    const departure = new Date(body.departureAt).getTime();
    assert.ok(departure >= before && departure <= after, 'the departure should be "now"');
    assert.strictEqual(
      body.trafficProfile,
      resolveTrafficProfile(new Date(departure), env.routing.rushHourWindows),
    );
  });
});

describe('one-way and reverse-traversal rules', () => {
  it('does not traverse a one-way edge backwards', async () => {
    // The direct edge is shapla-chattar -> sadarghat and is one-way, so the
    // return leg is unavailable and the route has to go round.
    const body = await estimateOk({
      originServicePointCode: 'sadarghat',
      destinationServicePointCode: 'shapla-chattar',
      departureAt: NORMAL_DEPARTURE,
    });

    assert.strictEqual(body.legs.length, 2, 'the direct edge must not be used in reverse');
    assert.ok(
      body.legs.every((leg) => leg.edgeCode !== ONE_WAY_EDGE),
      'a one-way edge must not appear on a route in the wrong direction',
    );

    const endpoints = await edgeEndpoints(body.legs.map((leg) => leg.edgeCode));
    assert.strictEqual(
      nodeBefore(endpoints.get(body.legs[0].edgeCode), body.legs[0]),
      await graphNodeIdOf('sadarghat'),
    );
    assert.strictEqual(
      nodeAfter(endpoints.get(body.legs.at(-1).edgeCode), body.legs.at(-1)),
      await graphNodeIdOf('shapla-chattar'),
    );
  });

  it('selects the alternative path in preference to a reverse traversal', async () => {
    // Same journey, but with the return leg enabled: now the direct edge is
    // usable and is confirmed to be the shorter option the router rejected above.
    const restore = await temporarilyChangeEdge(ONE_WAY_EDGE, ENABLE_REVERSE_LEG);
    try {
      const body = await estimateOk({
        originServicePointCode: 'sadarghat',
        destinationServicePointCode: 'shapla-chattar',
        departureAt: NORMAL_DEPARTURE,
      });

      assert.strictEqual(body.legs.length, 1);
      assert.strictEqual(body.legs[0].edgeCode, ONE_WAY_EDGE);
      assert.strictEqual(body.legs[0].direction, 'BACKWARD');
    } finally {
      await restore();
    }
  });

  it('uses the reverse duration when an edge is traversed backwards', async () => {
    const edge = edgeCode(DESTINATION, ORIGIN);
    const restore = await temporarilyChangeEdge(edge, SLOW_DOWN_REVERSE_LEG);
    try {
      const rush = await estimateOk({
        originServicePointCode: ORIGIN,
        destinationServicePointCode: DESTINATION,
        departureAt: RUSH_HOUR_DEPARTURE,
      });
      const normal = await estimateOk({
        originServicePointCode: ORIGIN,
        destinationServicePointCode: DESTINATION,
        departureAt: NORMAL_DEPARTURE,
      });

      assert.strictEqual(rush.legs.length, 1);
      assert.strictEqual(rush.legs[0].edgeCode, edge);
      assert.strictEqual(rush.legs[0].direction, 'BACKWARD');

      const stored = await edgeCosts([edge]);
      const row = stored.get(edge);

      // The artificial +600/+900 is only in the reverse columns, so a service
      // reading the forward columns would report the smaller number.
      assert.strictEqual(rush.legs[0].durationSeconds, row.reverse_rush_hour_duration_seconds);
      assert.strictEqual(normal.legs[0].durationSeconds, row.reverse_normal_duration_seconds);
      assert.ok(rush.legs[0].durationSeconds > row.rush_hour_duration_seconds);
      assert.ok(normal.legs[0].durationSeconds > row.normal_duration_seconds);
      assert.strictEqual(rush.durationSeconds, rush.legs[0].durationSeconds);
      assert.strictEqual(normal.durationSeconds, normal.legs[0].durationSeconds);
    } finally {
      await restore();
    }
  });

  it('traverses a bidirectional edge forwards when that is the direction of travel', async () => {
    const body = await estimateOk({
      originServicePointCode: DESTINATION,
      destinationServicePointCode: ORIGIN,
      departureAt: NORMAL_DEPARTURE,
    });

    assert.strictEqual(body.legs.length, 1);
    assert.strictEqual(body.legs[0].edgeCode, edgeCode(DESTINATION, ORIGIN));
    assert.strictEqual(body.legs[0].direction, 'FORWARD');

    const stored = await edgeCosts([body.legs[0].edgeCode]);
    assert.strictEqual(
      body.legs[0].durationSeconds,
      stored.get(body.legs[0].edgeCode).normal_duration_seconds,
    );
  });

  it('reverses the geometry of a backwards leg', async () => {
    // Edge banani-road-11 -> banani-kakoli runs north to south, so travelling
    // from kakoli to road 11 is a backwards traversal and the line must be
    // returned in the direction actually travelled.
    const forward = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: 'banani-kakoli',
      departureAt: NORMAL_DEPARTURE,
    });
    const backward = await estimateOk({
      originServicePointCode: 'banani-kakoli',
      destinationServicePointCode: ORIGIN,
      departureAt: NORMAL_DEPARTURE,
    });

    assert.strictEqual(forward.legs[0].direction, 'FORWARD');
    assert.strictEqual(backward.legs[0].direction, 'BACKWARD');

    assert.deepStrictEqual(
      backward.geometry.coordinates,
      [...forward.geometry.coordinates].reverse(),
      'the backwards line must be the forwards line reversed',
    );
  });
});

describe('route estimate errors', () => {
  it('rejects a missing origin or destination with 400', async () => {
    const missingOrigin = await estimate({ destinationServicePointCode: DESTINATION });
    assert.strictEqual(missingOrigin.status, 400);
    assert.match(missingOrigin.body.error.message, /originServicePointCode is required/);

    const missingDestination = await estimate({ originServicePointCode: ORIGIN });
    assert.strictEqual(missingDestination.status, 400);
    assert.match(missingDestination.body.error.message, /destinationServicePointCode is required/);
  });

  it('rejects a malformed service point code with 400', async () => {
    const response = await estimate({
      originServicePointCode: 'not a code!',
      destinationServicePointCode: DESTINATION,
    });

    assert.strictEqual(response.status, 400);
  });

  it('rejects a malformed or offset-less departure timestamp with 400', async () => {
    for (const departureAt of [
      '2026-09-24T08:41',
      '2026-09-24',
      'yesterday',
      '2026-02-30T00:00:00Z',
      '',
      1_760_000_000_000,
    ]) {
      const response = await estimate({
        originServicePointCode: ORIGIN,
        destinationServicePointCode: DESTINATION,
        departureAt,
      });

      assert.strictEqual(response.status, 400, `expected 400 for ${JSON.stringify(departureAt)}`);
      assert.match(response.body.error.message, /departureAt/);
    }
  });

  it('rejects unsupported body fields with 400', async () => {
    const response = await estimate({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      trafficProfile: 'NORMAL',
    });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported body field/);
  });

  it('rejects an unknown service point with 404', async () => {
    const unknownOrigin = await estimate({
      originServicePointCode: 'no-such-point',
      destinationServicePointCode: DESTINATION,
    });
    assert.strictEqual(unknownOrigin.status, 404);
    assert.match(unknownOrigin.body.error.message, /"no-such-point" was not found/);

    const unknownDestination = await estimate({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: 'no-such-point',
    });
    assert.strictEqual(unknownDestination.status, 404);
  });

  it('rejects an inactive service point with 409', async () => {
    await pool.query(`UPDATE service_points SET active = false WHERE code = $1`, ['banani-kakoli']);
    try {
      const response = await estimate({
        originServicePointCode: 'banani-kakoli',
        destinationServicePointCode: DESTINATION,
      });

      assert.strictEqual(response.status, 409);
      assert.match(response.body.error.message, /is inactive/);
    } finally {
      await pool.query(`UPDATE service_points SET active = true WHERE code = $1`, ['banani-kakoli']);
    }
  });

  it('rejects a point whose routing vertex is inactive with 409', async () => {
    await pool.query(`UPDATE routing_vertices SET active = false WHERE code = $1`, [
      vertexCode('banani-kakoli'),
    ]);
    try {
      const response = await estimate({
        originServicePointCode: 'banani-kakoli',
        destinationServicePointCode: DESTINATION,
      });

      assert.strictEqual(response.status, 409);
      assert.match(response.body.error.message, /not available for routing/);
    } finally {
      await pool.query(`UPDATE routing_vertices SET active = true WHERE code = $1`, [
        vertexCode('banani-kakoli'),
      ]);
    }
  });

  it('rejects an identical origin and destination with 400', async () => {
    const response = await estimate({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: ORIGIN,
    });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /must differ/);
  });

  it('reports an unreachable destination with 422', async () => {
    // farmgate -> khamarbari is one-way, so nothing in Khamarbari can get back
    // out to the rest of the network.
    const response = await estimate({
      originServicePointCode: 'khamarbari',
      destinationServicePointCode: ORIGIN,
    });

    assert.strictEqual(response.status, 422);
    assert.match(response.body.error.message, /No route from "khamarbari"/);
  });

  it('reports a point with no way out with 422 rather than a server error', async () => {
    const response = await estimate({
      originServicePointCode: 'niketon-gate',
      destinationServicePointCode: 'gulshan-2-circle',
    });

    assert.strictEqual(response.status, 422);
  });

  it('never returns a database message, SQL fragment or stack trace', async () => {
    const responses = await Promise.all([
      estimate({ originServicePointCode: 'no-such-point', destinationServicePointCode: DESTINATION }),
      estimate({ originServicePointCode: 'khamarbari', destinationServicePointCode: ORIGIN }),
      estimate({ originServicePointCode: ORIGIN, destinationServicePointCode: ORIGIN }),
    ]);

    for (const response of responses) {
      const serialized = JSON.stringify(response.body);
      for (const forbidden of ['SELECT', 'routing_edges', 'pgr_dijkstra', 'at ', 'Error:', 'sql']) {
        assert.ok(
          !serialized.includes(forbidden),
          `a client must not see "${forbidden}" (got ${serialized})`,
        );
      }
      assert.ok(!('stack' in response.body));
    }
  });

  it('rejects the wrong HTTP method with 404', async () => {
    const response = await api.request('/routes/estimate');
    assert.strictEqual(response.status, 404);
  });
});

describe('phase boundary', () => {
  it('exposes no pooling, matching, driver-acceptance or payment endpoint', async () => {
    for (const path of [
      '/routes',
      '/routes/quote',
      '/routes/fare',
      '/routes/price',
      '/pools',
      '/pool-members',
      '/matches',
      '/drivers',
      '/payments',
      '/wallets',
    ]) {
      const { status } = await api.request(path, { headers: { cookie: authCookie } });
      assert.strictEqual(status, 404, `${path} must not exist in this phase`);
    }
  });

  it('keeps the ride-request endpoints to the two shapes the milestone defined', async () => {
    // The ride-request milestone arrived after this one. It adds a passenger
    // collection (POST /ride-requests), the passenger's own history
    // (GET /ride-requests/my) and one request by id -- and nothing else. Reading
    // the collection, or addressing a request without a passenger session, is
    // still a 404.
    for (const path of ['/ride-requests', '/rides', '/ride-requests/my/events']) {
      const response = await api.request(path, { headers: { cookie: authCookie } });
      assert.strictEqual(response.status, 404, path);
    }

    // `/my` exists but still requires a session.
    const unauthenticated = await api.request('/ride-requests/my');
    assert.strictEqual(unauthenticated.status, 401);
  });

  it('introduces no shared or seated table', async () => {
    // The routing milestone also asserted that *pricing* was absent. The fare
    // milestone lifted that half deliberately, the ride-request milestone added
    // the ride tables, the dispatch milestone added the pool tables, the
    // shared-fare milestone added the two pool-fare tables and the TeslaPay
    // milestone added the three wallet tables. What must still hold is that
    // nothing shared, seated or assigned exists -- a shared *fare* is not a shared
    // *ride*: each passenger still has their own request, and the fare and wallet
    // tables only record what each of them owes and what they paid with.
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ~ '(ride|pool|dispatch|payment|wallet|match|seat_reservation|driver_assignment|shared)'
        ORDER BY table_name`,
    );

    assert.deepStrictEqual(rows.map((row) => row.table_name), [
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
    ]);
  });

  it('has exactly the six pricing tables the fare milestones added', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ~ '(fare|pricing|price|quote)'
        ORDER BY table_name`,
    );

    // Two from the solo-fare milestone -- a policy and an immutable quote -- and
    // four from shared fares: the calculation, its legs, each passenger's
    // allocation, and the share of each leg they pay for.
    assert.deepStrictEqual(rows.map((row) => row.table_name), [
      'fare_policies',
      'fare_quotes',
      'passenger_fare_allocations',
      'passenger_fare_leg_shares',
      'pool_fare_calculations',
      'pool_fare_legs',
    ]);
  });

  it('leaves the location endpoints untouched', async () => {
    const { status, body } = await api.request('/location/points/banani-road-11');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(Object.keys(body.data).sort(), [
      'code',
      'id',
      'latitude',
      'longitude',
      'name',
      'zoneCode',
    ]);
  });
});

describe('seeding', () => {
  it('stays idempotent, leaving the graph identifiers untouched', async () => {
    const snapshot = async () => {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM routing_vertices) AS vertices,
                (SELECT count(*)::int FROM routing_edges) AS edges,
                (SELECT max(graph_node_id) FROM routing_vertices) AS max_node,
                (SELECT max(graph_edge_id) FROM routing_edges) AS max_edge,
                (SELECT md5(string_agg(code || graph_node_id::text, ',' ORDER BY code))
                   FROM routing_vertices) AS node_fingerprint,
                (SELECT md5(string_agg(code || graph_edge_id::text, ',' ORDER BY code))
                   FROM routing_edges) AS edge_fingerprint`,
      );
      return rows[0];
    };

    const before = await snapshot();

    await runSeed();
    await runSeed();

    assert.deepStrictEqual(await snapshot(), before);
  });

  it('still routes after the seed has been re-applied', async () => {
    const body = await estimateOk({
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: NORMAL_DEPARTURE,
    });

    assert.ok(body.durationSeconds > 0);
  });
});
