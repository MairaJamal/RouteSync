import { TripRequest, Gender, GenderPreference } from "./types";
import { routeOverlapPct } from "./routeOverlap";

export interface MatchEvaluation {
  should_match: boolean;
  overlap_pct: number;
  reason?: string;
}

/**
 * Mutual gender-compatibility check, exported so matchPipeline.ts (Day 3
 * integration) can reuse it without duplicating the logic.
 *
 * Mirrors Person A's `are_trip_requests_gender_compatible` SQL function —
 * keep these two in sync. (Day 4 found the RLS SELECT policy had drifted
 * from this: it only handled 'any'/'female_only' and silently dropped
 * 'male_only'. Fixed in supabase/migrations/20260824000000_day4_fixes.sql.)
 */
export function isGenderCompatible(
  aGender: Gender,
  aPreference: GenderPreference,
  bGender: Gender,
  bPreference: GenderPreference
): boolean {
  const aOk =
    aPreference === "any" ||
    (aPreference === "male_only" && bGender === "male") ||
    (aPreference === "female_only" && bGender === "female");
  const bOk =
    bPreference === "any" ||
    (bPreference === "male_only" && aGender === "male") ||
    (bPreference === "female_only" && aGender === "female");
  return aOk && bOk;
}

/**
 * evaluateMatch — pure, synchronous gender + route-overlap check. Takes
 * route_geometry as given (no network calls), so it's safe to unit test
 * against hand-built or cached geometries. For the full async pipeline that
 * fetches live OSRM routes, runs the detour cap, and computes the fare
 * split, see matchPipeline.ts (used by runIntegration.ts / the API handler).
 */
export function evaluateMatch(
  a: TripRequest,
  b: TripRequest,
  minOverlapPct: number = 60
): MatchEvaluation {
  if (!isGenderCompatible(a.user_gender, a.gender_preference, b.user_gender, b.gender_preference)) {
    return { should_match: false, overlap_pct: 0, reason: "MUTUAL_GENDER_MISMATCH" };
  }

  if (!a.route_geometry || !b.route_geometry) {
    throw new Error("Both trip requests must have route_geometry set before matching");
  }

  const overlap = routeOverlapPct(a.route_geometry, b.route_geometry);
  const should_match = overlap >= minOverlapPct;

  return {
    should_match,
    overlap_pct: overlap,
    reason: should_match ? undefined : "INSUFFICIENT_OVERLAP",
  };
}
