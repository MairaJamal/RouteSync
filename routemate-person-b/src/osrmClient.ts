import { LocationPoint, OSRMRouteResult, formatForOSRM } from "./types";

const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";

/**
 * Fetch a route (2+ points, in visiting order) from OSRM.
 * Returns distance (m), duration (s), and GeoJSON LineString geometry.
 */
export async function getRoute(
  points: LocationPoint[],
  profile: "driving" | "walking" | "cycling" = "driving"
): Promise<OSRMRouteResult> {
  if (points.length < 2) {
    throw new Error("getRoute requires at least 2 points (origin + destination)");
  }

  const coordString = points
    .map(formatForOSRM)
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");

  const url = `${OSRM_BASE_URL}/route/v1/${profile}/${coordString}?overview=full&geometries=geojson`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OSRM request failed: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();

  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM returned no route: ${data.code || "unknown error"}`);
  }

  const route = data.routes[0];
  return {
    distance_m: route.distance,
    duration_s: route.duration,
    geometry: route.geometry,
    legs: route.legs?.map((leg: any) => ({
      distance_m: leg.distance,
      duration_s: leg.duration,
    })),
  };
}
