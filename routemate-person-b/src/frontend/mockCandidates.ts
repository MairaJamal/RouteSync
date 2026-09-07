/* Offline mock candidate dataset for RouteSync.
 *
 * When the Supabase-backed live matching is unreachable (missing API keys,
 * network error, pending migration) the search flow falls back to this
 * built-in dataset instead of failing. Unlike the old hardcoded
 * SAMPLE_MATCHES, nothing here is precomputed for display: every overlap
 * percentage, leg distance, and fare split is derived at query time from
 * real spatial geometry via routeOverlap.ts's buffered-intersection math,
 * using the same mutual gender-compatibility check as the live pipeline
 * (matchEngine.isGenderCompatible). Coordinates follow the app's standard
 * Islamabad sector grid (quick-pin values in InteractiveMapPicker.tsx), so
 * queries along the F-10 / G-9 → NUST corridors produce non-zero overlap.
 *
 * Pure TypeScript — no React, no network — so it runs identically in the
 * browser bundle, the Node backend, and the test suite.
 */

import { analyzeSharedSegments, SharedSegmentAnalysis, OVERLAP_BUFFER_M } from "../routeOverlap";
import { isGenderCompatible } from "../matchEngine";
import { LabeledLeg } from "../matchPipeline";
import {
  Gender,
  GenderPreference,
  GeoJSONLineString,
  LocationPoint,
  RatingSummary,
  VehicleType,
} from "../types";

/** Same canonical PKR/km rate the live fare pipeline uses (matchPipeline.ts). */
const MOCK_RATE_PER_KM = 30;

/** A mock only becomes a match above this overlap floor. Lower than the live
 *  60% gate on purpose: the dataset is tiny, so near-corridor companions
 *  (e.g. G-9 → NUST against an F-10 → NUST search) should still surface. */
const MOCK_MIN_OVERLAP_PCT = 15;

/** Rough city average speed (~43 km/h) used to derive leg durations. */
const MOCK_AVG_SPEED_M_S = 12;

/** Legs shorter than this collapse into their neighbours. */
const MIN_LEG_M = 50;

/** Vertex density for synthesized straight-corridor routes. */
const ROUTE_SEGMENTS = 30;

export interface MockCandidate {
  userId: string;
  displayName: string;
  phone: string;
  origin: LocationPoint;
  destination: LocationPoint;
  route: GeoJSONLineString;
  /** Whether this person brings their own car/bike (a "registered vehicle
   *  owner" from the Join-a-Driver filter's perspective). */
  ownsVehicle: boolean;
  vehicleType: "car" | "bike";
  gender: Gender;
  preference: GenderPreference;
  isVerified: boolean;
  verifiedDomain: string | null;
  rating: RatingSummary;
}

function loc(lat: number, lng: number, label: string): LocationPoint {
  return { lat, lng, address_label: label };
}

/** Densified straight corridor between two [lng, lat] points — enough
 *  vertices that the 40m-interval overlap walk interpolates cleanly. */
function densify(a: [number, number], b: [number, number], segments: number): GeoJSONLineString {
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    coordinates.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { type: "LineString", coordinates };
}

function candidateRoute(c: Omit<MockCandidate, "route">): GeoJSONLineString {
  return densify(
    [c.origin.lng, c.origin.lat],
    [c.destination.lng, c.destination.lat],
    16
  );
}

/* The local test dataset — four commuters covering the main corridors the
 * quick pins target: F-10→NUST (high overlap for that query), G-9→NUST
 * (converging corridor), F-7→NUST (passenger seeking a lift, for driver
 * demos) and F-11→G-9 (cross-town, disjoint from the NUST corridor). */
const MOCK_CANDIDATES: MockCandidate[] = (
  [
    {
      userId: "usr-zara-nust",
      displayName: "Zara Ahmed",
      phone: "+92 300 5550192",
      origin: loc(33.6938, 73.0135, "F-10 Markaz"),
      destination: loc(33.6425, 72.993, "NUST H-12 Gate 1"),
      ownsVehicle: true,
      vehicleType: "car" as const,
      gender: "female" as const,
      preference: "female_only" as const,
      isVerified: true,
      verifiedDomain: "nust.edu.pk",
      rating: { avg_stars: 4.9, rating_count: 18 },
    },
    {
      userId: "usr-hamza-fast",
      displayName: "Hamza Khan",
      phone: "+92 333 4441289",
      origin: loc(33.6917, 73.0336, "G-9 Markaz"),
      destination: loc(33.641, 72.9915, "NUST H-12 Gate 4"),
      ownsVehicle: true,
      vehicleType: "car" as const,
      gender: "male" as const,
      preference: "any" as const,
      isVerified: true,
      verifiedDomain: "fast.nu.edu.pk",
      rating: { avg_stars: 4.7, rating_count: 9 },
    },
    {
      userId: "usr-ayesha-qau",
      displayName: "Ayesha Malik",
      phone: "+92 321 9876543",
      origin: loc(33.72, 73.055, "F-7 Jinnah Super"),
      destination: loc(33.6425, 72.993, "NUST H-12 Gate 1"),
      ownsVehicle: false,
      vehicleType: "car" as const, // unused when ownsVehicle is false
      gender: "female" as const,
      preference: "female_only" as const,
      isVerified: true,
      verifiedDomain: "nust.edu.pk",
      rating: { avg_stars: 5.0, rating_count: 24 },
    },
    {
      userId: "usr-bilal-comsats",
      displayName: "Bilal Hussain",
      phone: "+92 345 5550177",
      origin: loc(33.6844, 72.9886, "F-11 Markaz"),
      destination: loc(33.6917, 73.0336, "G-9 Markaz"),
      ownsVehicle: true,
      vehicleType: "bike" as const,
      gender: "male" as const,
      preference: "any" as const,
      isVerified: false,
      verifiedDomain: null,
      rating: { avg_stars: 4.5, rating_count: 7 },
    },
  ] as Omit<MockCandidate, "route">[]
).map((c) => ({ ...c, route: candidateRoute(c) }));

/** Synthesized search route for the offline path (no OSRM available): a
 *  densified straight corridor between the two picked points. */
export function buildRequesterRoute(
  origin: LocationPoint,
  destination: LocationPoint
): GeoJSONLineString {
  return densify([origin.lng, origin.lat], [destination.lng, destination.lat], ROUTE_SEGMENTS);
}

export interface MockMatchOptions {
  origin: LocationPoint;
  destination: LocationPoint;
  userRole: "OFFERING" | "LOOKING";
  vehicleType: VehicleType;
  /** Only read when vehicleType === "ride_hailing". */
  rideHailingFarePkr?: number;
  currentUserGender: Gender;
  userPreference: GenderPreference;
  requireDriverGenderMatch: boolean;
  verifiedOnly: boolean;
  currentUserId: string;
}

export interface MockRouteGeometryBundle {
  requester: GeoJSONLineString;
  candidate: GeoJSONLineString;
  combined: GeoJSONLineString;
}

/** Structurally compatible with App.tsx's MatchItem (all its required fields
 *  present) so the same MatchCard renders live and offline results. */
export interface MockMatch {
  id: string;
  candidateDisplayName: string;
  candidateUserId: string;
  candidatePhone: string;
  candidateSectorFrom: string;
  candidateSectorTo: string;
  candidateIsVerified: boolean;
  candidateVerifiedDomain: string | null;
  candidateRating: RatingSummary;
  candidatePreference: GenderPreference;
  overlapPct: number;
  detourAddedMinutes: number;
  legs: LabeledLeg[];
  routeGeometry: MockRouteGeometryBundle;
  fareSplit: { user_id: string; total_fare: number; distance_share_pct?: number; distance_km?: number }[];
  matchType: "owner_passenger" | "shared_ride_hailing";
  /** Set for owner_passenger — whoever brings the vehicle rides free. */
  ownerUserId?: string;
  vehicleType: VehicleType;
  /** Only set when matchType === "shared_ride_hailing". */
  sharedFarePkr?: number;
  sharedFareNote?: string;
  status: "pending";
}

/** Build the offline match list for a search. Filters by mutual gender
 *  compatibility, the passenger-side driver-gender option, verification,
 *  and the role/mode gates (drivers see passengers, join-a-driver sees
 *  vehicle owners, cab-split sees anyone) — then scores each survivor's
 *  route against the search route with the real buffered-intersection
 *  geometry. Results are sorted by overlap, best first. */
export function buildMockMatches(opts: MockMatchOptions): MockMatch[] {
  const splitCab = opts.userRole === "LOOKING" && opts.vehicleType === "ride_hailing";
  if (splitCab && !(opts.rideHailingFarePkr && opts.rideHailingFarePkr > 0)) {
    return []; // nothing to split without a quote
  }

  const requesterRoute = buildRequesterRoute(opts.origin, opts.destination);
  const results: MockMatch[] = [];

  for (const cand of MOCK_CANDIDATES) {
    // Mutual gender compatibility — the exact check the live pipeline runs.
    if (
      !isGenderCompatible(
        opts.currentUserGender,
        opts.userPreference,
        cand.gender,
        cand.preference
      )
    ) {
      continue;
    }
    if (opts.requireDriverGenderMatch && cand.gender !== "female") continue;
    if (opts.verifiedOnly && !cand.isVerified) continue;

    // Role/mode gating: a driver offering a seat is matched with passengers
    // (other vehicle owners drive themselves), a passenger joining a driver
    // is matched with vehicle owners only, and a cab split works for anyone.
    if (opts.userRole === "OFFERING" && cand.ownsVehicle) continue;
    if (opts.userRole === "LOOKING" && opts.vehicleType === "none" && !cand.ownsVehicle) {
      continue;
    }

    const analysis = analyzeSharedSegments(requesterRoute, cand.route, OVERLAP_BUFFER_M);
    if (
      analysis.totalM <= 0 ||
      analysis.sharedM <= 0 ||
      analysis.firstSharedM === null ||
      analysis.lastSharedM === null
    ) {
      continue;
    }
    const overlapPct = Math.round((analysis.sharedM / analysis.totalM) * 10000) / 100;
    if (overlapPct < MOCK_MIN_OVERLAP_PCT) continue;

    results.push(buildMockMatch(opts, cand, requesterRoute, analysis, overlapPct, splitCab));
  }

  results.sort((a, b) => b.overlapPct - a.overlapPct);
  return results;
}

function buildMockMatch(
  opts: MockMatchOptions,
  cand: MockCandidate,
  requesterRoute: GeoJSONLineString,
  analysis: SharedSegmentAnalysis,
  overlapPct: number,
  splitCab: boolean
): MockMatch {
  // Split the search route into lead / shared / tail around the measured
  // shared corridor — the same blue/green/purple leg structure the live
  // pipeline emits, with distances that actually sum to the route.
  // (Nulls can't reach here — buildMockMatches `continue`s on them — but the
  // coalescing keeps this helper safe for reuse with raw analyses.)
  const leadM = analysis.firstSharedM ?? 0;
  const sharedEndM = analysis.lastSharedM ?? analysis.totalM;
  const sharedSpanM = sharedEndM - leadM;
  const tailM = Math.max(0, analysis.totalM - sharedEndM);

  const legs: LabeledLeg[] = [];
  let legIndex = 0;
  const pushLeg = (
    name: string,
    from: string,
    to: string,
    distanceM: number,
    color: LabeledLeg["color"],
    occupants: string[]
  ) => {
    if (distanceM <= MIN_LEG_M) return;
    legs.push({
      leg_index: legIndex++,
      name,
      from_label: from,
      to_label: to,
      distance_m: Math.round(distanceM),
      duration_s: Math.round(distanceM / MOCK_AVG_SPEED_M_S),
      color,
      occupant_user_ids: occupants,
    });
  };
  pushLeg("pickup_to_join", opts.origin.address_label, "Join point", leadM, "blue", [
    opts.currentUserId,
  ]);
  pushLeg(
    "shared_overlap",
    "Join point",
    "Dropoff point",
    sharedSpanM,
    "green",
    [opts.currentUserId, cand.userId]
  );
  pushLeg("dropoff_final", "Dropoff point", opts.destination.address_label, tailM, "purple", [
    opts.currentUserId,
  ]);
  if (legs.length === 0) {
    // Degenerate very-short route — collapse everything into one shared leg.
    legs.push({
      leg_index: 0,
      name: "shared_overlap",
      from_label: opts.origin.address_label,
      to_label: opts.destination.address_label,
      distance_m: Math.round(analysis.totalM),
      duration_s: Math.round(analysis.totalM / MOCK_AVG_SPEED_M_S),
      color: "green",
      occupant_user_ids: [opts.currentUserId, cand.userId],
    });
  }

  // Rider-kilometre shares for the distance_share_pct display column.
  const combinedRiderKm = analysis.totalM + analysis.sharedM;
  const userPct = combinedRiderKm > 0 ? Math.round((analysis.totalM / combinedRiderKm) * 100) : 50;
  const candPct = 100 - userPct;

  // The passenger rides (and is billed for) the shared leg, so fare math
  // uses the leg distance the card will actually display.
  const sharedLegKm = Math.max(legs[legs.length - 1]?.distance_m ?? sharedSpanM, sharedSpanM) / 1000;

  let matchType: MockMatch["matchType"];
  let ownerUserId: string | undefined;
  let vehicleType: VehicleType;
  let fareSplit: MockMatch["fareSplit"];
  let sharedFarePkr: number | undefined;
  let sharedFareNote: string | undefined;

  if (splitCab) {
    const quote = opts.rideHailingFarePkr!;
    // Proportional to rider-km (same weights as distance_share_pct).
    const userShare = Math.floor(quote * (userPct / 100) * 100) / 100;
    const candShare = Math.round((quote - userShare) * 100) / 100;
    const userKm = Math.round((analysis.totalM / 1000) * 1000) / 1000;
    const candKm = Math.round((analysis.sharedM / 1000) * 1000) / 1000;
    matchType = "shared_ride_hailing";
    ownerUserId = undefined; // nobody owns the cab
    vehicleType = "ride_hailing";
    fareSplit = [
      {
        user_id: opts.currentUserId,
        total_fare: userShare,
        distance_share_pct: userPct,
        distance_km: userKm,
      },
      {
        user_id: cand.userId,
        total_fare: candShare,
        distance_share_pct: candPct,
        distance_km: candKm,
      },
    ];
    sharedFarePkr = quote;
    sharedFareNote = `Yango/inDrive fare of Rs ${quote} split by km travelled (you ~${userPct}%, them ~${candPct}%).`;
  } else if (opts.userRole === "OFFERING") {
    // The current user is the vehicle owner: they ride free, the passenger
    // pays the per-km fare for the shared stretch.
    matchType = "owner_passenger";
    ownerUserId = opts.currentUserId;
    vehicleType = opts.vehicleType === "bike" ? "bike" : "car";
    fareSplit = [
      { user_id: opts.currentUserId, total_fare: 0, distance_share_pct: userPct },
      {
        user_id: cand.userId,
        total_fare: Math.round(MOCK_RATE_PER_KM * sharedLegKm),
        distance_share_pct: candPct,
      },
    ];
  } else {
    // Passenger joining a driver: the candidate owns the vehicle.
    matchType = "owner_passenger";
    ownerUserId = cand.userId;
    vehicleType = cand.vehicleType;
    fareSplit = [
      {
        user_id: opts.currentUserId,
        total_fare: Math.round(MOCK_RATE_PER_KM * sharedLegKm),
        distance_share_pct: userPct,
      },
      { user_id: cand.userId, total_fare: 0, distance_share_pct: candPct },
    ];
  }

  // The driven trip path: the driver's origin first (when the candidate
  // brings the vehicle), then the search corridor.
  const candidateIsOwner = !splitCab && opts.userRole === "LOOKING";
  const combined: GeoJSONLineString = candidateIsOwner
    ? {
        type: "LineString",
        coordinates: [
          [cand.origin.lng, cand.origin.lat] as [number, number],
          ...requesterRoute.coordinates,
        ],
      }
    : requesterRoute;

  return {
    id: `mock-${cand.userId}`,
    candidateDisplayName: cand.displayName,
    candidateUserId: cand.userId,
    candidatePhone: cand.phone,
    candidateSectorFrom: cand.origin.address_label,
    candidateSectorTo: cand.destination.address_label,
    candidateIsVerified: cand.isVerified,
    candidateVerifiedDomain: cand.verifiedDomain,
    candidateRating: cand.rating,
    candidatePreference: cand.preference,
    overlapPct,
    detourAddedMinutes: Math.max(0, Math.round((leadM / 1000) * 2)),
    legs,
    routeGeometry: { requester: requesterRoute, candidate: cand.route, combined },
    fareSplit,
    matchType,
    ownerUserId,
    vehicleType,
    sharedFarePkr,
    sharedFareNote,
    status: "pending",
  };
}
