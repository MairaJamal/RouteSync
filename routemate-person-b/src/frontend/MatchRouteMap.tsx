/* NEW: Live route-overlap map for a match. This is the visual companion
   to MatchCard's RouteBar — same blue/green/purple leg colors, same leg
   data (LabeledLeg[] from matchPipeline.ts), but drawn on a real map
   using the real OSRM geometry the backend already computes and now
   returns as route_geometry.{requester,candidate,combined}. No new
   backend work: this was already in the API response and simply wasn't
   consumed by the frontend before.

   Animation: solo routes (dashed, muted) fade in first so a viewer sees
   "these are two different people's trips" before the combined route
   draws itself leg-by-leg in the same colors as RouteBar, so the overlap
   claim in the match card is visibly, not just numerically, true. */
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { GeoJSONLineString } from "../types";
import { LabeledLeg } from "../matchPipeline";

const LEG_COLOR_HEX: Record<LabeledLeg["color"], string> = {
  blue: "#2563eb",
  green: "#16a34a",
  purple: "#7c3aed",
};

interface Props {
  requesterGeometry: GeoJSONLineString | null;
  candidateGeometry: GeoJSONLineString | null;
  combinedGeometry: GeoJSONLineString | null;
  legs: LabeledLeg[];
  /** ms per animation frame step; lower = faster draw. Exposed mainly so
   *  tests/storybook-style manual checks can speed this up. */
  stepMs?: number;
}

/** Splits the combined route's coordinate array into per-leg slices,
 *  proportional to each leg's share of total distance. OSRM points
 *  aren't perfectly evenly spaced, so this is an approximation — good
 *  enough to visually match the leg boundaries without needing the
 *  backend to return per-leg geometry separately. */
function sliceCoordsByLegs(
  coords: [number, number][],
  legs: LabeledLeg[]
): { color: LabeledLeg["color"]; coords: [number, number][] }[] {
  const totalDistance = legs.reduce((sum, l) => sum + l.distance_m, 0) || 1;
  const segments: { color: LabeledLeg["color"]; coords: [number, number][] }[] = [];
  let cursor = 0;
  legs.forEach((leg, i) => {
    const fraction = leg.distance_m / totalDistance;
    const isLast = i === legs.length - 1;
    const endIdx = isLast ? coords.length - 1 : Math.round(cursor + fraction * (coords.length - 1));
    // Overlap the boundary point with the next segment so the drawn line
    // has no visible gaps between differently-colored legs.
    segments.push({ color: leg.color, coords: coords.slice(Math.floor(cursor), endIdx + 1) });
    cursor = endIdx;
  });
  return segments.filter((s) => s.coords.length >= 2);
}

export default function MatchRouteMap({
  requesterGeometry,
  candidateGeometry,
  combinedGeometry,
  legs,
  stepMs = 18,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    });

    // High-resolution, clean CartoDB Voyager map tiles
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    // Critical fix: force map to recalculate container viewport
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Resize recalculation
    const resizeTimer = setTimeout(() => {
      map.invalidateSize();
    }, 100);

    // Clear any previous run's layers (route changed, or replay clicked).
    layersRef.current.forEach((l) => map.removeLayer(l));
    layersRef.current = [];

    const allCoords: [number, number][] = [];
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // Note: these helpers are const arrows (not hoisted function
    // declarations) so TypeScript keeps the null-guard narrowing of `map`
    // inside their bodies — hoisted declarations reset it.
    const addLatLngLine = (coords: [number, number][], opts: L.PolylineOptions) => {
      const latlngs = coords.map(([lng, lat]) => [lat, lng]) as L.LatLngExpression[];
      const line = L.polyline(latlngs, opts).addTo(map);
      layersRef.current.push(line);
      return line;
    };

    // Helper for beautiful waypoint pin
    const addWaypoint = (lat: number, lng: number, label: string, color: string) => {
      const icon = L.divIcon({
        className: "rm-route-pin",
        html: `
          <div style="
            background: ${color};
            color: #fff;
            padding: 3px 8px;
            border-radius: 999px;
            font-size: 10px;
            font-family: var(--rm-font-display, monospace);
            font-weight: 700;
            white-space: nowrap;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            border: 2px solid #fff;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          ">
            <span style="width: 5px; height: 5px; background: #fff; border-radius: 50%;"></span>
            ${label}
          </div>
        `,
        iconSize: [70, 24],
        iconAnchor: [35, 12],
      });
      const marker = L.marker([lat, lng], { icon }).addTo(map);
      layersRef.current.push(marker);
      return marker;
    };

    if (requesterGeometry && requesterGeometry.coordinates.length > 0) {
      addLatLngLine(requesterGeometry.coordinates, {
        color: "#94a3b8",
        weight: 3,
        dashArray: "3 6",
        opacity: 0.7,
      });
      allCoords.push(...requesterGeometry.coordinates);
    }
    if (candidateGeometry && candidateGeometry.coordinates.length > 0) {
      addLatLngLine(candidateGeometry.coordinates, {
        color: "#94a3b8",
        weight: 3,
        dashArray: "3 6",
        opacity: 0.7,
      });
      allCoords.push(...candidateGeometry.coordinates);
    }

    // Add start and end points
    if (allCoords.length > 0) {
      const first = allCoords[0];
      const last = allCoords[allCoords.length - 1];
      addWaypoint(first[1], first[0], "Start", "var(--rm-route-blue, #2563eb)");
      addWaypoint(last[1], last[0], "Dest", "var(--rm-route-purple, #7c3aed)");

      map.fitBounds(
        allCoords.map(([lng, lat]) => [lat, lng]) as L.LatLngBoundsExpression,
        { padding: [30, 30] }
      );
    }

    // Draw the combined, leg-colored route progressively
    if (combinedGeometry && legs.length > 0) {
      const segments = sliceCoordsByLegs(combinedGeometry.coordinates, legs);
      let delay = 350;
      segments.forEach((seg) => {
        const latlngs = seg.coords.map(([lng, lat]) => [lat, lng]) as L.LatLngExpression[];
        const line = L.polyline([], {
          color: LEG_COLOR_HEX[seg.color],
          weight: 5,
          opacity: 0.95,
        }).addTo(map);
        layersRef.current.push(line);

        latlngs.forEach((pt, i) => {
          const t = setTimeout(() => {
            if (cancelled) return;
            line.addLatLng(pt);
          }, delay + i * stepMs);
          timeouts.push(t);
        });
        delay += latlngs.length * stepMs + 100;
      });
    }

    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      timeouts.forEach(clearTimeout);
    };
  }, [requesterGeometry, candidateGeometry, combinedGeometry, legs, replayKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "280px",
          borderRadius: "var(--rm-radius, 10px)",
          border: "1.5px solid var(--rm-border, #d8ddd4)",
          overflow: "hidden",
          boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setReplayKey((k) => k + 1)}
          style={{
            alignSelf: "flex-start",
            fontFamily: "var(--rm-font-display)",
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.02em",
            color: "var(--rm-ink)",
            background: "var(--rm-paper-raised)",
            border: "1px solid var(--rm-border)",
            borderRadius: "999px",
            padding: "4px 12px",
            cursor: "pointer",
          }}
        >
          ↻ Replay route match
        </button>
        <span style={{ fontSize: "11px", color: "var(--rm-ink-soft)", fontFamily: "var(--rm-font-display)" }}>
          Islamabad Road Network
        </span>
      </div>
    </div>
  );
}
