// ─────────────────────────────────────────────────────────────
// SOS: nearest-police-station lookup.
//
// WHY OVERPASS (OpenStreetMap)
// The rest of this project already leans on free, key-less
// infrastructure (OSRM for routing, wa.me for alerts, Google Maps
// deep links for directions). Overpass is the same shape: a public
// read-only OSM API, no signup, no billing, no rate-limit key to
// rotate. Pakistan's police-station coverage on OSM is dense enough
// for our purpose — "give the rider the closest station they can
// actually call or navigate to", not a canonical directory.
//
// WHAT COUNTS AS A POLICE STATION
// We query three tags and union them, because OSM mappers haven't
// standardised on one:
//   amenity=police       — the classic tag for a station building
//   emergency=police     — sometimes used on nodes without amenity
//   office=police        — used for administrative HQs; still useful
//
// FAILURE MODE
// Any Overpass hiccup (5xx, timeout, malformed JSON) is swallowed
// and returned as an empty list — the SOS flow must never block on
// this call. The frontend always offers the national helpline (15)
// and the user's emergency contacts regardless of what we return.
// ─────────────────────────────────────────────────────────────

export interface NearbyPoliceStation {
  osm_type: "node" | "way" | "relation";
  osm_id: string;
  name: string;
  lat: number;
  lng: number;
  /** Raw phone from OSM tags — may be `;`-separated or absent. We
   *  pass through untouched; the frontend turns it into a tel: link. */
  phone?: string;
  /** Best-effort street/area label assembled from addr:* tags. */
  address?: string;
  /** Straight-line distance from the caller's position, in km. */
  distance_km: number;
}

export interface FindNearestPoliceOptions {
  /** Search radius in metres. Default 10 000 (10 km). Widened
   *  automatically once if the first pass returns nothing. */
  radius_m?: number;
  /** Max stations returned, sorted nearest-first. Default 3. */
  limit?: number;
  /** Overpass endpoint(s). Pass a string to pin one, or an array to
   *  override the default mirror-fallback list. Kept configurable so
   *  tests can point at a fixture. */
  endpoint?: string | string[];
  /** Millisecond cap on a single mirror's fetch. Default 8 000 —
   *  Overpass is usually < 1 500 ms for a small-radius tag query, but
   *  we do not want a slow mirror to stall the SOS modal. Each mirror
   *  in the fallback list gets its own timeout. */
  timeout_ms?: number;
}

/** Public Overpass mirrors, tried in order. The primary instance
 *  (overpass-api.de) frequently returns 502 under load, so we fall
 *  through to alternates rather than silently giving up. */
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const DEFAULT_RADIUS_M = 10_000;
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 8_000;

/** Build the Overpass QL query. Kept as a pure function so it's easy
 *  to unit-test the exact string without a network. */
export function buildOverpassQuery(lat: number, lng: number, radius_m: number): string {
  return `[out:json][timeout:15];
(
  nwr["amenity"="police"](around:${radius_m},${lat},${lng});
  nwr["emergency"="police"](around:${radius_m},${lat},${lng});
  nwr["office"="police"](around:${radius_m},${lat},${lng});
);
out center tags;`;
}

/** Haversine distance in km. Cheap, no deps, accurate enough for
 *  "which of these three stations is closest". */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Turn an Overpass element into our shape, or null if it lacks the
 *  minimum viable fields (a coordinate). Ways/relations report their
 *  centroid under `center` when we ask for `out center`. */
function toStation(el: any, fromLat: number, fromLng: number): NearbyPoliceStation | null {
  const lat: number | undefined =
    typeof el?.lat === "number" ? el.lat : typeof el?.center?.lat === "number" ? el.center.lat : undefined;
  const lng: number | undefined =
    typeof el?.lon === "number" ? el.lon : typeof el?.center?.lon === "number" ? el.center.lon : undefined;
  if (lat == null || lng == null) return null;

  const tags = el?.tags ?? {};
  const name: string =
    (typeof tags.name === "string" && tags.name.trim()) ||
    (typeof tags["name:ur"] === "string" && tags["name:ur"].trim()) ||
    (typeof tags["name:en"] === "string" && tags["name:en"].trim()) ||
    "Police Station";

  const addrParts = [
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
  ].filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0);

  const osmType: NearbyPoliceStation["osm_type"] =
    el.type === "way" ? "way" : el.type === "relation" ? "relation" : "node";

  return {
    osm_type: osmType,
    osm_id: String(el.id),
    name,
    lat,
    lng,
    phone: typeof tags.phone === "string" ? tags.phone : typeof tags["contact:phone"] === "string" ? tags["contact:phone"] : undefined,
    address: addrParts.length ? addrParts.join(", ") : undefined,
    distance_km: Number(haversineKm(fromLat, fromLng, lat, lng).toFixed(2)),
  };
}

/** Minimal Promise.any stand-in. The project's tsconfig lib is ES2020,
 *  which predates Promise.any / AggregateError (ES2021); rather than
 *  widen the shared compiler lib for one call, this resolves with the
 *  first fulfilled value and rejects only when every input rejects. */
function anyValue<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (promises.length === 0) {
      reject(new Error("All Overpass mirrors failed"));
      return;
    }
    let remaining = promises.length;
    promises.forEach((p) => {
      p.then(resolve).catch(() => {
        remaining -= 1;
        if (remaining === 0) {
          reject(new Error("All Overpass mirrors failed"));
        }
      });
    });
  });
}

/** Race every mirror concurrently and resolve with the FIRST valid
 *  JSON. Sequential fallback was rejected on purpose: an SOS lookup
 *  must not spend 8s x N mirrors waiting out a slow or 502-ing
 *  instance while someone is in danger. Each mirror gets its own
 *  AbortController; losers are cancelled so we don't leak sockets.
 *
 *  Rejects only if every mirror fails or the overall deadline passes. */
async function fetchOverpass(endpoints: string[], query: string, timeout_ms: number): Promise<any> {
  if (endpoints.length === 0) throw new Error("No Overpass endpoints configured");

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout_ms);

  const attempts = endpoints.map(async (endpoint) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        // Overpass public instances reject requests without a UA
        // (HTTP 406). This string is our contact handle per their
        // usage policy — keep it stable and descriptive.
        "User-Agent": "RouteSync-SOS/1.0 (routemate-person-b; safety lookup)",
      },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Overpass ${endpoint} failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  });

  try {
    // Resolve with the first fulfilled mirror and ignore the rest;
    // reject only when ALL fail.
    return await anyValue(attempts);
  } finally {
    clearTimeout(deadline);
    // Cancel any still-pending losers so the race doesn't hold the loop.
    controller.abort();
  }
}

/** Public entry point. Always resolves — never throws — so the SOS
 *  flow can safely fire-and-await it. Returns [] on any error. */
export async function findNearestPoliceStations(
  lat: number,
  lng: number,
  opts: FindNearestPoliceOptions = {}
): Promise<NearbyPoliceStation[]> {
  if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
    return [];
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];

  const endpoints = Array.isArray(opts.endpoint)
    ? opts.endpoint
    : opts.endpoint
      ? [opts.endpoint]
      : OVERPASS_ENDPOINTS;
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const radius = Math.max(500, opts.radius_m ?? DEFAULT_RADIUS_M);

  const query = (r: number) => buildOverpassQuery(lat, lng, r);

  const collect = async (r: number): Promise<NearbyPoliceStation[]> => {
    const json = await fetchOverpass(endpoints, query(r), timeout_ms);
    const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
    const seen = new Set<string>();
    const stations: NearbyPoliceStation[] = [];
    for (const el of elements) {
      const s = toStation(el, lat, lng);
      if (!s) continue;
      const key = `${s.osm_type}:${s.osm_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stations.push(s);
    }
    stations.sort((a, b) => a.distance_km - b.distance_km);
    return stations;
  };

  try {
    let stations = await collect(radius);
    // Widen once if we found nothing — a rural user 12 km from the
    // nearest thana still deserves a suggestion.
    if (stations.length === 0 && radius < 25_000) {
      stations = await collect(Math.min(25_000, radius * 2.5));
    }
    return stations.slice(0, limit);
  } catch (err) {
    console.warn("[policeLocator] Overpass lookup failed:", (err as Error).message);
    return [];
  }
}
