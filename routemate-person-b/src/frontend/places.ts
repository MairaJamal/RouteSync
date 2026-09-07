import { LocationPoint } from "../types";

const PHOTON_URL = "https://photon.komoot.io/api/";
// Islamabad centroid — biases in-bbox result ordering toward the city
// center without excluding the Rawalpindi side of the service area.
const ISLAMABAD_LAT = 33.6844;
const ISLAMABAD_LNG = 73.0479;

// ─────────────────────────────────────────────────────────────
// Operational service area — the Islamabad / Rawalpindi metro region
// (ICT + Rawalpindi district + the New Islamabad International Airport
// at ~33.55, 72.83 and Bhara Kahu in the east). Geocoding is bbox-
// restricted to this area, and every selected pickup/drop-off is
// validated against it before a search can run — RouteSync has no
// matching coverage outside it yet.
// ─────────────────────────────────────────────────────────────
export const SERVICE_AREA_BOUNDS = {
  latMin: 33.45,
  lngMin: 72.75,
  latMax: 33.85,
  lngMax: 73.45,
} as const;

export const SERVICE_AREA_LABEL = "Islamabad / Rawalpindi";

/** True when a [lat, lng] coordinate lies inside the operational
 *  service area. Non-finite coordinates are always out of area. */
export function isWithinServiceArea(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= SERVICE_AREA_BOUNDS.latMin &&
    lat <= SERVICE_AREA_BOUNDS.latMax &&
    lng >= SERVICE_AREA_BOUNDS.lngMin &&
    lng <= SERVICE_AREA_BOUNDS.lngMax
  );
}

export interface PlaceSuggestion {
  label: string;
  sectorCode: string | null;
  point: LocationPoint;
}

/** Pulls a Islamabad-style sector code ("F-10", "G-9") out of a free-text
 *  address if one is present, for the sector-chip badge in the UI. */
function extractSectorCode(text: string): string | null {
  const match = text.match(/\b([A-I])[\s-]?(\d{1,2})\b/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  if (query.trim().length < 2) return [];

  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("lat", String(ISLAMABAD_LAT));
  url.searchParams.set("lon", String(ISLAMABAD_LNG));
  url.searchParams.set("location_bias_scale", "0.8");
  // Hard-restrict geocoding to the operational service area (Photon's
  // bbox format is minLon,minLat,maxLon,maxLat), so a search for "Paris"
  // or "Lahore" can never resolve to a point we can't match.
  url.searchParams.set(
    "bbox",
    `${SERVICE_AREA_BOUNDS.lngMin},${SERVICE_AREA_BOUNDS.latMin},${SERVICE_AREA_BOUNDS.lngMax},${SERVICE_AREA_BOUNDS.latMax}`
  );
  url.searchParams.set("limit", "6");

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`Photon request failed: ${res.status}`);

  const data = await res.json();
  const features: any[] = data.features ?? [];

  // Belt-and-braces client-side filter: even with the bbox parameter,
  // only points we can actually serve become suggestions.
  return features
    .filter((f) => {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      return isWithinServiceArea(lat, lng);
    })
    .map((f) => {
      const props = f.properties ?? {};
      const parts = [props.name, props.street, props.district ?? props.city].filter(Boolean);
      const label = parts.join(", ") || "Unnamed location";
      const [lng, lat] = f.geometry.coordinates;
      return {
        label,
        sectorCode: extractSectorCode(label),
        point: { lat, lng, address_label: label },
      };
    });
}

export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<PlaceSuggestion> {
  try {
    const url = new URL("https://photon.komoot.io/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));

    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`Reverse geocode failed: ${res.status}`);

    const data = await res.json();
    const features: any[] = data.features ?? [];
    if (features.length === 0) {
      const fallbackLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      return {
        label: fallbackLabel,
        sectorCode: extractSectorCode(fallbackLabel),
        point: { lat, lng, address_label: fallbackLabel },
      };
    }

    const props = features[0].properties ?? {};
    const parts = [props.name, props.street, props.district ?? props.city].filter(Boolean);
    const label = parts.join(", ") || `Point (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

    return {
      label,
      sectorCode: extractSectorCode(label),
      point: { lat, lng, address_label: label },
    };
  } catch {
    const fallbackLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    return {
      label: fallbackLabel,
      sectorCode: extractSectorCode(fallbackLabel),
      point: { lat, lng, address_label: fallbackLabel },
    };
  }
}

