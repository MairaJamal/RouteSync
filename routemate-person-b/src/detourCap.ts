import { LocationPoint, OSRMRouteResult } from "./types";
import { getRoute } from "./osrmClient";

export interface DetourCheckResult {
  approved: boolean;
  original_duration_s: number;
  detour_duration_s: number;
  added_minutes: number;
  waypoint_order: LocationPoint[];
}

export const DETOUR_CAP_MINUTES = 15;

/** Pure math core — split out so it's unit-testable without hitting OSRM. */
export function evaluateDetour(originalDurationS: number, detourDurationS: number) {
  const addedMinutes = (detourDurationS - originalDurationS) / 60;
  return {
    approved: addedMinutes <= DETOUR_CAP_MINUTES,
    added_minutes: Math.round(addedMinutes * 100) / 100,
  };
}

/**
 * Checks whether inserting an additional rider's pickup/dropoff as waypoints
 * into the lead trip's route adds no more than DETOUR_CAP_MINUTES.
 *
 * origin/destination: the lead trip's fixed start/end points
 * originalRoute: the lead trip's solo route (already fetched via getRoute)
 * newWaypoints: the joining rider's origin (+ destination if it's not the same
 *   final stop) to insert, in visiting order
 */
export async function checkDetourCap(
  origin: LocationPoint,
  destination: LocationPoint,
  originalRoute: OSRMRouteResult,
  newWaypoints: LocationPoint[]
): Promise<DetourCheckResult> {
  // Naive ordering: insert new waypoints between origin and destination in
  // the order given. Good enough for 1-2 extra riders; swap in a real
  // permutation/TSP search later if we support >2 simultaneous joins.
  const waypointOrder = [origin, ...newWaypoints, destination];

  const detourRoute = await getRoute(waypointOrder);
  const { approved, added_minutes } = evaluateDetour(
    originalRoute.duration_s,
    detourRoute.duration_s
  );

  return {
    approved,
    original_duration_s: originalRoute.duration_s,
    detour_duration_s: detourRoute.duration_s,
    added_minutes,
    waypoint_order: waypointOrder,
  };
}
