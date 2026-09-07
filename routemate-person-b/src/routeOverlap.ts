import { GeoJSONLineString } from "./types";

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in meters between two [lng, lat] points */
export function haversineDistance(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Cumulative along-polyline distances: [0, d1, d2, …] in meters. */
function cumulativeDistances(coords: [number, number][]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineDistance(coords[i - 1], coords[i]));
  }
  return cum;
}

/** Total length of a polyline in meters. */
export function polylineLengthM(line: GeoJSONLineString): number {
  const cum = cumulativeDistances(line.coordinates);
  return cum[cum.length - 1] ?? 0;
}

/** Point at `targetDist` meters along the polyline (clamped to its ends).
 *  `cum` is the precomputed cumulative-distance array for `coords`. */
function pointAtDistance(
  coords: [number, number][],
  cum: number[],
  targetDist: number
): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1 || targetDist <= 0) return coords[0];

  const total = cum[cum.length - 1];
  if (targetDist >= total) return coords[coords.length - 1];

  // Linear walk — callers step monotonically, so this stays O(n) overall.
  let segIdx = 1;
  while (segIdx < cum.length - 1 && cum[segIdx] < targetDist) {
    segIdx++;
  }
  const segStart = cum[segIdx - 1];
  const segLen = cum[segIdx] - segStart;
  const t = segLen === 0 ? 0 : (targetDist - segStart) / segLen;

  const [lng1, lat1] = coords[segIdx - 1];
  const [lng2, lat2] = coords[segIdx];
  return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
}

/** Resample a LineString into exactly `n` evenly spaced points along its length. */
export function samplePolyline(line: GeoJSONLineString, n: number = 20): [number, number][] {
  const coords = line.coordinates;
  if (coords.length === 0) return [];
  if (coords.length === 1) return Array(n).fill(coords[0]);

  const cum = cumulativeDistances(coords);
  const totalDist = cum[cum.length - 1];
  if (totalDist === 0) return Array(n).fill(coords[0]);

  const samples: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    samples.push(pointAtDistance(coords, cum, (totalDist * i) / (n - 1)));
  }
  return samples;
}

/** Distance in meters from point `p` to ONE polyline segment [a, b], using a
 *  local equirectangular projection around `p` — accurate far beyond the
 *  few-hundred-meter tolerances used here, at a fraction of haversine cost.
 *  All inputs are [lng, lat]. */
function pointToSegmentDistanceM(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const degToM = Math.PI / 180;
  const cosLat0 = Math.cos(toRad(p[1]));

  // Project into meters relative to p (so p sits at the origin).
  const ax = (a[0] - p[0]) * cosLat0 * EARTH_RADIUS_M * degToM;
  const ay = (a[1] - p[1]) * EARTH_RADIUS_M * degToM;
  const bx = (b[0] - p[0]) * cosLat0 * EARTH_RADIUS_M * degToM;
  const by = (b[1] - p[1]) * EARTH_RADIUS_M * degToM;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt(ax * ax + ay * ay);

  // Closest point on the segment, with the projection clamped to [0, 1].
  let t = -(ax * dx + ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Minimum distance in meters from a point to a polyline (0 when the point
 *  lies on the line; Infinity for an empty line or a point far outside the
 *  line's bounding box — the common disjoint-route case, skipped in O(1)). */
export function distanceToPolylineM(p: [number, number], line: GeoJSONLineString): number {
  const coords = line.coordinates;
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return haversineDistance(p, coords[0]);

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  // ≈ 5.5 km margin — comfortably above the largest tolerance we ever use,
  // so a point outside the expanded bbox can never be within tolerance.
  const margin = 0.05;
  if (
    p[0] < minLng - margin ||
    p[0] > maxLng + margin ||
    p[1] < minLat - margin ||
    p[1] > maxLat + margin
  ) {
    return Infinity;
  }

  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentDistanceM(p, coords[i - 1], coords[i]);
    if (d < best) best = d;
  }
  return best;
}

/** Tolerance corridor used when deciding whether two routes "share" a
 *  stretch of road. Two GPS/route traces of the same street never coincide
 *  exactly (different snapping, zoom levels, direction), so anything within
 *  this buffer of the other route counts as shared — the same semantics as
 *  buffering one polyline and intersecting it with the other. */
export const OVERLAP_BUFFER_M = 500;

/** Sampling step for the shared-length measurement: route A is walked in
 *  intervals no longer than this so shared distance is *measured*, not
 *  guessed from a handful of sample points. */
const OVERLAP_STEP_M = 40;

/** Hard cap on intervals per route pair so very long routes stay fast. */
const MAX_OVERLAP_INTERVALS = 600;

/** Result of walking route A and classifying which stretches fall inside
 *  route B's tolerance buffer. `firstSharedM` / `lastSharedM` are distances
 *  measured along route A from its start, bounding the span where the two
 *  routes travel together (null when they never come within tolerance). */
export interface SharedSegmentAnalysis {
  totalM: number;
  sharedM: number;
  firstSharedM: number | null;
  lastSharedM: number | null;
}

/** analyzeSharedSegments — walk route A in short fixed-length intervals and
 *  classify each interval as shared (its midpoint lies within
 *  `thresholdMeters` of route B) or not. This is the single measurement
 *  pass behind both sharedSegmentLengthM and routeOverlapPct, and also
 *  reports WHERE along route A the shared corridor begins and ends so
 *  callers can split the route into lead/shared/tail legs. */
export function analyzeSharedSegments(
  routeA: GeoJSONLineString,
  routeB: GeoJSONLineString,
  thresholdMeters: number = OVERLAP_BUFFER_M
): SharedSegmentAnalysis {
  const coordsA = routeA.coordinates;
  if (coordsA.length < 2 || routeB.coordinates.length === 0) {
    return { totalM: 0, sharedM: 0, firstSharedM: null, lastSharedM: null };
  }

  const cum = cumulativeDistances(coordsA);
  const total = cum[cum.length - 1];
  if (total <= 0) {
    return { totalM: 0, sharedM: 0, firstSharedM: null, lastSharedM: null };
  }

  const interval = Math.max(OVERLAP_STEP_M, total / MAX_OVERLAP_INTERVALS);
  const n = Math.max(1, Math.ceil(total / interval));
  const step = total / n;

  let shared = 0;
  let firstSharedM: number | null = null;
  let lastSharedM: number | null = null;
  for (let k = 0; k < n; k++) {
    const mid = pointAtDistance(coordsA, cum, (k + 0.5) * step);
    if (distanceToPolylineM(mid, routeB) <= thresholdMeters) {
      shared += step;
      const start = k * step;
      const end = start + step;
      if (firstSharedM === null || start < firstSharedM) firstSharedM = start;
      if (lastSharedM === null || end > lastSharedM) lastSharedM = end;
    }
  }
  return { totalM: total, sharedM: shared, firstSharedM, lastSharedM };
}

/**
 * sharedSegmentLengthM — the length of route A (in meters) that lies within
 * `thresholdMeters` of route B, i.e. the length of the two polylines'
 * spatial intersection inside the tolerance buffer. Route A is walked in
 * short fixed-length intervals and an interval counts as shared when its
 * midpoint falls inside B's buffer corridor.
 */
export function sharedSegmentLengthM(
  routeA: GeoJSONLineString,
  routeB: GeoJSONLineString,
  thresholdMeters: number = OVERLAP_BUFFER_M
): number {
  return analyzeSharedSegments(routeA, routeB, thresholdMeters).sharedM;
}

/**
 * routeOverlapPct — percentage (0-100) of the SEARCH route's total length
 * that lies within `thresholdMeters` of the candidate route:
 *
 *   overlap% = (shared segment length / total search route distance) × 100
 *
 * The shared length comes from the buffered spatial intersection of the two
 * polylines (sharedSegmentLengthM above) — real OSRM road geometry, not
 * static percentages. Symmetric callers can flip the argument order to
 * score the other route; the matching pipeline always scores the
 * REQUESTER's route (route A) because that's whose trip is being extended.
 */
export function routeOverlapPct(
  routeA: GeoJSONLineString,
  routeB: GeoJSONLineString,
  thresholdMeters: number = OVERLAP_BUFFER_M
): number {
  const total = polylineLengthM(routeA);
  if (total <= 0) return 0;
  const shared = sharedSegmentLengthM(routeA, routeB, thresholdMeters);
  return Math.round((shared / total) * 10000) / 100;
}
