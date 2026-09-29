/**
 * Dhaka location seed data: service zones, their pickup/drop-off points, and
 * the routing graph that joins those points.
 *
 * ---------------------------------------------------------------------------
 * APPROXIMATE DEMO DATA -- NOT VERIFIED NAVIGATION COORDINATES
 * ---------------------------------------------------------------------------
 * Every coordinate below is a hand-written, neighbourhood-level approximation
 * for a named Dhaka location. None of it comes from a survey, a geocoder, or a
 * routing engine, and none of it should be treated as a real navigation answer.
 * The MVP deliberately has no maps, geocoding, or external routing APIs.
 *
 * What is guaranteed here is *internal* consistency, which the seeder asserts
 * before it writes anything:
 *   * every zone and point code is unique and follows the project's code format;
 *   * every coordinate is a valid WGS84 pair inside DHAKA_BOUNDS;
 *   * the three points of a zone never share identical coordinates;
 *   * every edge references a point that exists, and no edge is a self-loop.
 *
 * Coordinates are written as { latitude, longitude } on purpose. PostGIS wants
 * longitude first, and utils/geo.js is the single place that order is applied.
 *
 * ---------------------------------------------------------------------------
 * GRAPH SHAPE
 * ---------------------------------------------------------------------------
 * Each zone's three points are chained together (point 1 -> 2 -> 3), and the
 * zones are linked to each other through named streets, which makes the whole
 * graph weakly connected. Edges are straight two-point LineStrings between the
 * coordinates above -- plausible demo geometry, not road centrelines.
 *
 * Edge codes are derived, not written out: `edge-<from>-to-<to>`. That keeps
 * them stable and impossible to typo independently of the endpoints.
 */

/**
 * Speeds used to turn a measured edge length into a duration.
 *
 * These are demo assumptions for Dhaka traffic, not measurements. Durations are
 * derived rather than hand-written so an edge can never claim thirty seconds
 * for five kilometres, and so rush hour can never come out faster than normal.
 */
export const DEMO_SPEED_KMH = Object.freeze({
  normal: 24,
  rushHour: 14,
});

/** Zones, each with exactly the three points the brief requires. */
export const LOCATION_ZONES = [
  {
    code: 'banani',
    name: 'Banani',
    points: [
      { code: 'banani-road-11', name: 'Banani Road 11', latitude: 23.7937, longitude: 90.4043 },
      { code: 'banani-kakoli', name: 'Banani Kakoli', latitude: 23.7897, longitude: 90.4039 },
      {
        code: 'banani-chairman-bari',
        name: 'Banani Chairman Bari',
        latitude: 23.7859,
        longitude: 90.4023,
      },
    ],
  },
  {
    code: 'gulshan',
    name: 'Gulshan',
    points: [
      {
        code: 'gulshan-1-circle',
        name: 'Gulshan 1 Circle',
        latitude: 23.7807,
        longitude: 90.4151,
      },
      {
        code: 'gulshan-2-circle',
        name: 'Gulshan 2 Circle',
        latitude: 23.7925,
        longitude: 90.4147,
      },
      { code: 'niketon-gate', name: 'Niketon Gate', latitude: 23.7779, longitude: 90.4113 },
    ],
  },
  {
    code: 'mohakhali',
    name: 'Mohakhali',
    points: [
      {
        code: 'mohakhali-bus-terminal',
        name: 'Mohakhali Bus Terminal',
        latitude: 23.774,
        longitude: 90.4006,
      },
      {
        code: 'mohakhali-wireless-gate',
        name: 'Mohakhali Wireless Gate',
        latitude: 23.7779,
        longitude: 90.4061,
      },
      {
        code: 'mohakhali-dohs-gate',
        name: 'Mohakhali DOHS Gate',
        latitude: 23.7823,
        longitude: 90.3965,
      },
    ],
  },
  {
    code: 'mirpur',
    name: 'Mirpur',
    points: [
      { code: 'mirpur-10', name: 'Mirpur 10 / Mirpur Dosh', latitude: 23.8069, longitude: 90.3687 },
      { code: 'mirpur-1', name: 'Mirpur 1', latitude: 23.7955, longitude: 90.3547 },
      { code: 'mirpur-dohs-gate', name: 'Mirpur DOHS Gate', latitude: 23.8273, longitude: 90.3628 },
    ],
  },
  {
    code: 'baily-road',
    name: 'Baily Road',
    points: [
      { code: 'baily-road', name: 'Baily Road', latitude: 23.7421, longitude: 90.4077 },
      { code: 'siddheswari', name: 'Siddheswari', latitude: 23.7413, longitude: 90.4147 },
      { code: 'shantinagar', name: 'Shantinagar', latitude: 23.739, longitude: 90.4135 },
    ],
  },
  {
    code: 'dhanmondi',
    name: 'Dhanmondi',
    points: [
      { code: 'dhanmondi-27', name: 'Dhanmondi 27', latitude: 23.7465, longitude: 90.376 },
      {
        code: 'rabindra-sarobar',
        name: 'Rabindra Sarobar',
        latitude: 23.7423,
        longitude: 90.381,
      },
      { code: 'jigatola', name: 'Jigatola', latitude: 23.7365, longitude: 90.3755 },
    ],
  },
  {
    code: 'uttara',
    name: 'Uttara',
    points: [
      { code: 'house-building', name: 'House Building', latitude: 23.8676, longitude: 90.3932 },
      { code: 'rajlaxmi', name: 'Rajlaxmi', latitude: 23.8721, longitude: 90.3988 },
      {
        code: 'jashimuddin-road',
        name: 'Jashimuddin Road',
        latitude: 23.8759,
        longitude: 90.3795,
      },
    ],
  },
  {
    code: 'farmgate',
    name: 'Farmgate',
    points: [
      { code: 'farmgate', name: 'Farmgate', latitude: 23.758, longitude: 90.39 },
      { code: 'khamarbari', name: 'Khamarbari', latitude: 23.7567, longitude: 90.3877 },
      { code: 'indira-road', name: 'Indira Road', latitude: 23.753, longitude: 90.3869 },
    ],
  },
  {
    code: 'motijheel',
    name: 'Motijheel',
    points: [
      { code: 'shapla-chattar', name: 'Shapla Chattar', latitude: 23.733, longitude: 90.417 },
      { code: 'dilkusha', name: 'Dilkusha', latitude: 23.7295, longitude: 90.4168 },
      { code: 'arambagh', name: 'Arambagh', latitude: 23.74, longitude: 90.413 },
    ],
  },
  {
    code: 'jatrabari',
    name: 'Jatrabari',
    points: [
      {
        code: 'jatrabari-intersection',
        name: 'Jatrabari Intersection',
        latitude: 23.7104,
        longitude: 90.4345,
      },
      { code: 'sayedabad', name: 'Sayedabad', latitude: 23.7135, longitude: 90.4285 },
      { code: 'dholaipar', name: 'Dholaipar', latitude: 23.708, longitude: 90.425 },
    ],
  },
  {
    code: 'bashundhara',
    name: 'Bashundhara',
    points: [
      {
        code: 'bashundhara-gate',
        name: 'Bashundhara Gate',
        latitude: 23.8223,
        longitude: 90.4265,
      },
      {
        code: 'jamuna-future-park',
        name: 'Jamuna Future Park',
        latitude: 23.8135,
        longitude: 90.4245,
      },
      {
        code: 'north-south-university',
        name: 'North South University',
        latitude: 23.8155,
        longitude: 90.427,
      },
    ],
  },
  {
    code: 'badda',
    name: 'Badda',
    points: [
      { code: 'badda-link-road', name: 'Badda Link Road', latitude: 23.7807, longitude: 90.4265 },
      { code: 'middle-badda', name: 'Middle Badda', latitude: 23.777, longitude: 90.423 },
      { code: 'merul-badda', name: 'Merul Badda', latitude: 23.7835, longitude: 90.4195 },
    ],
  },
  {
    code: 'tejgaon',
    name: 'Tejgaon',
    points: [
      {
        code: 'tejgaon-link-road',
        name: 'Tejgaon Link Road',
        latitude: 23.7595,
        longitude: 90.396,
      },
      { code: 'nabisco', name: 'Nabisco', latitude: 23.766, longitude: 90.393 },
      { code: 'satrasta', name: 'Satrasta', latitude: 23.761, longitude: 90.39 },
    ],
  },
  {
    code: 'mohammadpur',
    name: 'Mohammadpur',
    points: [
      {
        code: 'mohammadpur-town-hall',
        name: 'Mohammadpur Town Hall',
        latitude: 23.763,
        longitude: 90.36,
      },
      { code: 'asad-gate', name: 'Asad Gate', latitude: 23.7595, longitude: 90.369 },
      { code: 'bosila', name: 'Bosila', latitude: 23.753, longitude: 90.348 },
    ],
  },
  {
    code: 'old-dhaka',
    name: 'Old Dhaka',
    points: [
      { code: 'sadarghat', name: 'Sadarghat', latitude: 23.7104, longitude: 90.4074 },
      { code: 'lalbagh', name: 'Lalbagh', latitude: 23.7195, longitude: 90.388 },
      { code: 'chawkbazar', name: 'Chawkbazar', latitude: 23.7183, longitude: 90.395 },
    ],
  },
];

/**
 * Routing edges.
 *
 * `bidirectional` defaults to true, so only the deliberately one-way edges
 * declare it. `fareWeight` is a relative weight used by a later phase -- it is
 * NOT a fare, and nothing here stores money.
 *
 * Durations are not listed: the seeder derives them from the PostGIS-measured
 * length using DEMO_SPEED_KMH, so they always agree with the geometry. A reverse
 * duration for a two-way edge defaults to the same value, because one geometry
 * describes the pair.
 */
export const LOCATION_EDGES = [
  // --- Intra-zone chains: the three points of each zone, in order -----------
  { from: 'banani-road-11', to: 'banani-kakoli' },
  { from: 'banani-kakoli', to: 'banani-chairman-bari' },

  { from: 'gulshan-1-circle', to: 'gulshan-2-circle' },
  // One-way: the Gulshan 2 to Niketon slip is treated as a single direction.
  { from: 'gulshan-2-circle', to: 'niketon-gate', bidirectional: false },

  { from: 'mohakhali-bus-terminal', to: 'mohakhali-wireless-gate' },
  { from: 'mohakhali-wireless-gate', to: 'mohakhali-dohs-gate' },

  { from: 'mirpur-10', to: 'mirpur-1' },
  { from: 'mirpur-1', to: 'mirpur-dohs-gate' },

  { from: 'baily-road', to: 'siddheswari', bidirectional: false },
  { from: 'siddheswari', to: 'shantinagar' },

  { from: 'dhanmondi-27', to: 'rabindra-sarobar' },
  { from: 'rabindra-sarobar', to: 'jigatola' },

  { from: 'house-building', to: 'rajlaxmi' },
  { from: 'rajlaxmi', to: 'jashimuddin-road' },

  { from: 'farmgate', to: 'khamarbari', bidirectional: false },
  { from: 'khamarbari', to: 'indira-road' },

  { from: 'shapla-chattar', to: 'dilkusha' },
  { from: 'dilkusha', to: 'arambagh' },

  { from: 'jatrabari-intersection', to: 'sayedabad' },
  { from: 'sayedabad', to: 'dholaipar' },

  { from: 'bashundhara-gate', to: 'jamuna-future-park' },
  { from: 'jamuna-future-park', to: 'north-south-university' },

  { from: 'badda-link-road', to: 'middle-badda' },
  { from: 'middle-badda', to: 'merul-badda' },

  { from: 'tejgaon-link-road', to: 'nabisco' },
  { from: 'nabisco', to: 'satrasta' },

  { from: 'mohammadpur-town-hall', to: 'asad-gate' },
  { from: 'asad-gate', to: 'bosila' },

  { from: 'sadarghat', to: 'lalbagh' },
  { from: 'lalbagh', to: 'chawkbazar' },

  // --- Inter-zone links: these are what make the graph one network ----------
  { from: 'mohammadpur-town-hall', to: 'dhanmondi-27' },
  { from: 'dhanmondi-27', to: 'farmgate' },
  { from: 'farmgate', to: 'tejgaon-link-road' },
  { from: 'tejgaon-link-road', to: 'mohakhali-bus-terminal' },
  { from: 'mohakhali-bus-terminal', to: 'banani-road-11', fareWeight: 1.5 },
  { from: 'banani-road-11', to: 'gulshan-1-circle' },
  // Gulshan 1 Circle and Mohakhali Bus Terminal are both a short hop from Banani
  // and only a hop and a half from each other, but without this link the only
  // road between them runs back up Banani Road 11 -- 4.0 km to cover the 1.7 km
  // that actually separates them. A car pooling two passengers at Banani, one for
  // each, would spend that 4.0 km retracing its own route.
  { from: 'gulshan-1-circle', to: 'mohakhali-bus-terminal', fareWeight: 1.5 },
  { from: 'gulshan-1-circle', to: 'badda-link-road' },
  { from: 'badda-link-road', to: 'bashundhara-gate' },
  { from: 'bashundhara-gate', to: 'house-building' },
  { from: 'mohakhali-bus-terminal', to: 'mirpur-10', fareWeight: 1.5 },
  { from: 'farmgate', to: 'baily-road' },
  { from: 'shantinagar', to: 'shapla-chattar' },
  { from: 'shapla-chattar', to: 'sadarghat', bidirectional: false, fareWeight: 0.75 },
  { from: 'sadarghat', to: 'jatrabari-intersection' },
  // Two extra links so the network is not a bare spanning tree.
  { from: 'gulshan-1-circle', to: 'tejgaon-link-road' },
  { from: 'shapla-chattar', to: 'jatrabari-intersection' },
];
